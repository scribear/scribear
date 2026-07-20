"""
Defines WorkerProcessManager that manages main process communication with WorkerProcess
"""

import asyncio
import logging
import threading
from collections import deque
from dataclasses import dataclass
from queue import Empty
from typing import Any, Callable, Generic, TypeVar, cast

import multiprocess as mp
from multiprocess.queues import Queue

from src.shared.logger import ContextLogger, Logger
from src.shared.utils.event_emitter import Event, EventEmitter

from .job_context_interface import JobContextInterface
from .job_interface import JobInterface
from .job_result import (
    JobException,
    JobExecutionObservation,
    JobObserver,
    JobSuccess,
)
from .result import JobExecutionResult, Result, ResultType
from .task import (
    DeregisterJobTask,
    QueueDataTask,
    RegisterJobTask,
    Task,
    TerminateWorkerTask,
    UpdateJobConfigTask,
)
from .worker_log_handler import WorkerLogHandler
from .worker_process import WorkerProcess
from .worker_state import WorkerState

NS_PER_SEC = 1000000000

# Rolling window over which a worker's busy/idle ratio is averaged.
ROLLING_UTILIZATION_WINDOW_NS = 10 * 60 * NS_PER_SEC

# How long a single background get() blocks before the poll loop rechecks its
# stop flag. Bounds how long the (daemon) result-poller thread can be parked in
# a blocking queue read on an idle queue.
RESULT_POLL_TIMEOUT_SEC = 0.1

# How long wait_shutdown() waits for the worker process (and then the poller
# thread) to exit on its own before forcing it. Generous enough for a graceful
# exit that finishes the in-flight batch and destroys contexts, but bounded so
# a wedged worker or reader can never hang shutdown indefinitely.
WORKER_EXIT_TIMEOUT_SEC = 10.0

C = TypeVar("C", bound=tuple)
D = TypeVar("D")
R = TypeVar("R")
Conf = TypeVar("Conf")


class JobHandle(Generic[D, R, Conf], EventEmitter):
    """
    Handle to a job registered to WorkerProcessManager
    """

    JobResultEvent = Event[JobSuccess[R] | JobException]("JOB_RESULT")

    @property
    def worker_id(self):
        """
        Gets worker id of worker that job is registered to
        """
        return self._worker_id

    @property
    def job_id(self):
        """
        Gets registered job id
        """
        return self._job_id

    def __init__(
        self,
        worker_id: int,
        job_id: int,
        queue_data: Callable[[list[D]], None],
        update_config: Callable[[Conf], None],
        deregister: Callable[..., None],
    ):
        """
        Args:
            worker_id     - Worker id of worker that job is registered to
            job_id        - Registered job id
            queue_data    - Callback function to queue data to be processed
            update_config - Callback function to queue a config update
            deregister    - Callback function to deregister job
        """
        super().__init__()

        self._worker_id = worker_id
        self._job_id = job_id

        self._queue_data = queue_data
        self._update_config = update_config
        self._deregister = deregister

    def queue_data(self, data: list[D]) -> None:
        """
        Queue sequence of data to be processed by job
        Does nothing if job has been deregistered

        Args:
            data    - Sequence of data to be queued
        """
        if not self._queue_data:
            return
        self._queue_data(data)

    def update_config(self, config: Conf) -> None:
        """
        Queue a config update to be applied between data batches by the job
        Splits the current data buffer at the time of this call so that data
        queued before this update is processed under the old config and data
        queued after is processed under the new one.
        Does nothing if job has been deregistered

        Args:
            config  - New config to apply
        """
        if not self._update_config:
            return
        self._update_config(config)

    def deregister(self) -> None:
        """
        Deregisters job from worker
        Does nothing if job has already been deregistered
        """
        if not self._deregister:
            return
        self._deregister()

        self._queue_data = None
        self._update_config = None
        self._deregister = None


class _RollingUtilization:
    """
    Handles computing rolling untilization for WorkerProcess based on time between state changes
    Takes in a sequence of states + time spent in that state and computes process utilization
    """

    @property
    def utilization(self):
        """
        Gets the current rolling utilization from 0-1
        """
        if self._total_time_ns == 0:
            return 0
        return 1 - ((self._idle_time_ns) / self._total_time_ns)

    def __init__(self, rolling_window_ns: int):
        """
        Args:
            rolling_window_ns   - Length of rolling window in nanoseconds
        """
        self._idle_time_ns = 0
        self._busy_time_ns = 0

        self._total_time_ns = 0
        self._rolling_window_ns = rolling_window_ns

        self._increments = deque[tuple[WorkerState, int]]()

    def increment(self, state: WorkerState, increment_ns: int):
        """
        Handle a single state change event

        Args:
            state           - State worker was in
            increment_ns    - Time in nanoseconds worker spent in state
        """
        self._increments.append((state, increment_ns))
        self._increment(state, increment_ns)

        # Remove old state changes from rolling window
        oldest_state, oldest_increment_ns = self._increments[0]
        while len(self._increments) > 0:
            new_total_time = self._total_time_ns - oldest_increment_ns

            # Window has been shrunk to correct size
            if new_total_time < self._rolling_window_ns:
                return

            self._increments.popleft()
            self._increment(oldest_state, -1 * oldest_increment_ns)

            oldest_state, oldest_increment_ns = self._increments[0]

    def _increment(self, state: WorkerState, increment_ns: int):
        """
        Internal handler for single state change event
        Updates internal counters accordingly

        Args:
            state           - State to update
            increment_ns    - Time in nanoseconds to change counter by
        """
        self._total_time_ns += increment_ns
        if state == WorkerState.IDLE:
            self._idle_time_ns += increment_ns
        elif state == WorkerState.BUSY:
            self._busy_time_ns += increment_ns


@dataclass(frozen=True)
class WorkerSnapshot:
    """
    Point-in-time view of one worker, safe to read from a request handler

    Exists so callers outside the pool can observe worker load without
    reaching through private attributes.
    """

    worker_id: int
    utilization: float
    live_job_count: int
    total_jobs_registered: int
    context_ids: set[int]


class WorkerProcessManager:
    """
    Main process interface for managing WorkerProcess

    Usage
    ```
    class Context(JobContextInterface[int]):
        def __init__(self):
            super().__init__(tags={"some_context"})

        def create(self, log: Logger) -> int:
            return 42

        def destroy(self, log: ContextLogger, context: int) -> None:
            return


    class Job(JobInterface[int, int, int]):
        def process_batch(
            self, log: ContextLogger, context: int, batch: list[int]
        ) -> int:
            return sum(batch) + context


    # Create WorkerProcessManager
    worker_id = 0
    context_def: dict[int, JobContextInterface[Any]] = {0: Context()}
    rolling_utilization_window_sec = 5 * 60
    wpm = WorkerProcessManager(
        logger, worker_id, context_def, rolling_utilization_window_sec
    )

    # Register a job
    context_id = 0
    period_ms = 100
    handle = wpm.register_job(context_id, period_ms, Job())

    # Queue data for job to process
    handle.queue_data([1, 2, 3])
    handle.queue_data([4, 5, 6])

    # Handle job results
    handle.on(handle.JobResultEvent, lambda result: print(result))  # Prints 63

    # Give job time to execute
    await asyncio.sleep(1)

    handle.deregister()

    # Shutdown worker process
    wpm.send_terminate()
    wpm.wait_shutdown()
    ```
    """

    @staticmethod
    def _worker_function(
        task_queue: Queue[Task],
        result_queue: Queue[Result],
        context_defs: dict[int, JobContextInterface[Any]],
        log_level: int,
        logger_context: dict[str, Any],
    ):
        """
        Entrypoint for worker process
        Creates logger and initializes WorkerProcess class

        Args:
            task_queue      - Read only queue for fetching admin tasks from main process
            result_queue    - Write only queue for pushing results to main process
            context_defs    - Mapping from context id to context definitions assigned
                                to this worker. Eagerly created at startup.
            log_level       - Application log level
            logger_context  - Context to initialize worker's application logger with
        """
        logger = logging.getLogger("__worker_process__")
        logger.setLevel(log_level)

        # Use custom handler that pushes log records to result queue rather
        logger.propagate = False
        logger.handlers.clear()
        logger.addHandler(WorkerLogHandler(result_queue))

        log = ContextLogger(logger, logger_context)

        try:
            return WorkerProcess(
                log, task_queue, result_queue, context_defs
            ).execution_loop()
        finally:
            # Flush pending result writes before releasing the queue, then
            # cancel the task queue feeder (worker only reads from it) so
            # process exit doesn't leave the resource_tracker holding stale
            # semaphore references.
            result_queue.close()
            result_queue.join_thread()
            task_queue.cancel_join_thread()
            task_queue.close()

    @property
    def utilization(self):
        """
        Gets current rolling utilization of WorkerProcess
        """
        return self._rolling_utilization.utilization

    @property
    def context_ids(self) -> set[int]:
        """
        Gets set of context_ids this worker has initialized
        """
        return set(self._context_defs.keys())

    @property
    def worker_id(self) -> int:
        """
        Gets unique identifier of the worker this manages
        """
        return self._worker_id

    @property
    def live_job_count(self) -> int:
        """
        Gets number of jobs currently registered to this worker
        """
        return len(self._registered_job_handles)

    @property
    def total_jobs_registered(self) -> int:
        """
        Gets number of jobs ever registered to this worker

        Monotonic for the lifetime of the worker process, so consumers can
        difference successive reads to get a registration rate.
        """
        return self._next_job_id

    def snapshot(self) -> WorkerSnapshot:
        """
        Gets a point-in-time view of this worker's load

        Side effect free, so it is safe to call from a request handler.
        """
        return WorkerSnapshot(
            worker_id=self._worker_id,
            utilization=self.utilization,
            live_job_count=self.live_job_count,
            total_jobs_registered=self.total_jobs_registered,
            context_ids=self.context_ids,
        )

    def __init__(
        self,
        logger: Logger,
        worker_id: int,
        context_defs: dict[int, JobContextInterface[Any]],
        rolling_utilization_window_ns: int = ROLLING_UTILIZATION_WINDOW_NS,
        job_observer: JobObserver | None = None,
    ):
        """
        Constructor blocks until the worker process has finished creating all
        assigned contexts. Raises RuntimeError if context initialization fails
        so the pool startup can abort before any job is accepted.

        Args:
            logger          - Application logger
            worker_id       - Unique identifier for worker
            context_defs    - Mapping from context id to context definitions to
                                initialize on this worker
            rolling_utilization_window_ns - Override for utilization smoothing window
                                              (production should use the default)
            job_observer    - Optional callback invoked on the event loop thread
                                for every completed job execution
        """
        self._log = logger.child({"worker_id": worker_id})
        self._worker_id = worker_id
        self._job_observer = job_observer

        self._rolling_utilization = _RollingUtilization(
            rolling_utilization_window_ns
        )

        self._next_job_id = 0
        self._context_defs = context_defs
        self._registered_job_handles: dict[int, JobHandle[Any, Any, Any]] = {}
        self._job_labels: dict[int, str] = {}

        # Signals the result-poller thread to stop. Set during wait_shutdown.
        self._stopping = threading.Event()

        # False positive
        # pylint: disable=no-member
        ctx = mp.get_context("spawn")

        self._task_queue = cast(Queue[Task], ctx.Queue())
        self._result_queue = cast(Queue[Result], ctx.Queue())

        self._process = ctx.Process(
            target=WorkerProcessManager._worker_function,
            args=(
                self._task_queue,
                self._result_queue,
                context_defs,
                self._log.logger.level,
                self._log.context,
            ),
        )
        self._process.start()

        # Block until worker confirms it has created every assigned context.
        # Drain log records that may arrive before the init result. Poll with a
        # timeout and watch process liveness so a worker that dies during
        # initialization (e.g. a native model-load crash that never reports an
        # error) raises here instead of blocking the constructor forever - the
        # parent holds the result queue's write fd, so a blocking read would
        # never see EOF on worker exit.
        while True:
            try:
                result = self._result_queue.get(
                    block=True, timeout=RESULT_POLL_TIMEOUT_SEC
                )
            except Empty:
                if not self._process.is_alive():
                    raise RuntimeError(
                        f"Worker {worker_id} exited during initialization "
                        f"(exit code {self._process.exitcode})"
                    ) from None
                continue
            if result.type == ResultType.LOGGING:
                self._log.logger.handle(result.record)
                continue
            if result.type != ResultType.INITIALIZE_WORKER:
                raise RuntimeError(
                    f"Unexpected result during worker init: {result.type}"
                )
            if result.error is not None:
                self._process.join()
                raise RuntimeError(
                    f"Worker {worker_id} failed to initialize: {result.error}"
                )
            break

        # Poll for worker results on a dedicated daemon thread rather than via
        # asyncio.to_thread. A to_thread call runs on the event loop's default
        # executor, which loop.close() joins on teardown; if the blocking queue
        # read is wedged (the parent holds the write fd, so it never sees EOF),
        # that join - and shutdown - hangs forever. A daemon thread we own is
        # never joined at loop close and never blocks interpreter exit, so a
        # wedged read can no longer hang teardown. Results are marshalled back
        # onto the event loop so job handlers keep running there.
        self._loop = asyncio.get_running_loop()
        self._poll_thread = threading.Thread(
            target=self._poll_loop,
            name=f"wpm-result-poller-{worker_id}",
            daemon=True,
        )
        self._poll_thread.start()

    def _poll_loop(self):
        """
        Daemon-thread loop that pulls results from the worker's result queue.

        Log records are handled inline (logging is thread-safe) so that shutdown
        log records are flushed even while the event loop is blocked in
        wait_shutdown. Job and state-change results are marshalled onto the event
        loop so job handlers and utilization bookkeeping keep running on the loop
        thread, exactly as before. Runs until wait_shutdown sets the stop flag or
        the queue is closed.
        """
        while not self._stopping.is_set():
            try:
                result = self._result_queue.get(
                    block=True, timeout=RESULT_POLL_TIMEOUT_SEC
                )
            except Empty:
                continue
            except (OSError, ValueError, EOFError):
                # Queue closed / connection torn down during shutdown.
                break

            if result.type == ResultType.LOGGING:
                self._log.logger.handle(result.record)
                continue

            try:
                self._loop.call_soon_threadsafe(
                    self._handle_loop_result, result
                )
            except RuntimeError:
                # Event loop already closed; nothing left to dispatch to.
                break

    def _handle_loop_result(self, result: Result):
        """
        Handle a non-logging worker result on the event loop thread. Emits job
        results to their handles and folds state changes into the utilization
        window - both of which touch loop-thread state, so they must not run on
        the poller thread.
        """
        if result.type == ResultType.STATE_CHANGE:
            self._rolling_utilization.increment(
                result.state, result.time_elapsed_ns
            )
        elif result.type == ResultType.JOB_EXECUTION:
            # Observe before the registration check: a result that arrives
            # after its job was deregistered still describes work the worker
            # really did, and dropping it would under-report utilization
            # exactly when jobs are churning.
            self._observe_job_execution(result)

            if result.job_id not in self._registered_job_handles:
                return
            job_handle = self._registered_job_handles[result.job_id]
            job_handle.emit(job_handle.JobResultEvent, result.result)

            if result.result.has_exception:
                job_handle.deregister()

    def _observe_job_execution(self, result: JobExecutionResult):
        """
        Reports a completed job execution to the configured observer

        Args:
            result  - Job execution result received from the worker

        The observer is out-of-band bookkeeping (metrics), so a fault in it
        must not take the result-dispatch path down with it - a job result
        that never reaches its handle would stall a live transcription
        session. Failures are logged and swallowed.
        """
        if self._job_observer is None:
            return

        job_result = result.result
        try:
            self._job_observer(
                JobExecutionObservation(
                    worker_id=self._worker_id,
                    job_id=result.job_id,
                    label=self._job_labels.get(result.job_id, ""),
                    stats=job_result.stats,
                    exception=(
                        job_result.value if job_result.has_exception else None
                    ),
                    counters=job_result.counters,
                )
            )
        # pylint: disable-next=broad-exception-caught
        except Exception as error:
            self._log.error(
                "Job observer raised", context={"error": str(error)}
            )

    def register_job(
        self,
        context_ids: tuple[int, ...],
        period_ms: int,
        job: JobInterface[C, D, R, Conf],
        label: str = "",
    ) -> JobHandle[D, R, Conf]:
        """
        Registers a new job with WorkerProcess

        Args:
            context_ids     - Context ids of context instances to provide to Job, can be empty
            period_ms       - Frequency at which job should be run
            job             - Definition of job to register
            label           - Opaque grouping label reported to the job observer

        Returns:
            JobHandle for registered job

        Raises:
            KeyError if invalid context id is provided
        """
        for context_id in context_ids:
            if context_id not in self._context_defs:
                raise KeyError("Invalid Context Id")

        job_id = self._next_job_id
        self._next_job_id += 1

        self._task_queue.put(
            RegisterJobTask(job_id, context_ids, period_ms, job)
        )

        def _queue_data(data: list[D]):
            self._task_queue.put(QueueDataTask(job_id, data))

        def _update_config(config: Conf):
            self._task_queue.put(UpdateJobConfigTask(job_id, config))

        def _deregister():
            self._task_queue.put(DeregisterJobTask(job_id))
            del self._registered_job_handles[job_id]
            # Kept only while the job lives, so the label map cannot grow with
            # the number of sessions the process has ever served.
            self._job_labels.pop(job_id, None)

        job_handle = JobHandle[D, R, Conf](
            self._worker_id, job_id, _queue_data, _update_config, _deregister
        )
        self._registered_job_handles[job_id] = job_handle
        self._job_labels[job_id] = label
        return job_handle

    def send_terminate(self):
        """
        Send signal to gracefully shut down worker process

        Does not wait for process to exit
        Call wait_shutdown() after send_terminate() to wait for process to exit
        """
        self._task_queue.put(TerminateWorkerTask())

    def _drain_logging_results(self, block_timeout: float | None):
        """
        Fetch a single result from the result queue, if available, and log it
        if it is a logging result. Used during shutdown once the async
        poller has been stopped.

        Args:
            block_timeout   - None to poll without blocking, a float to block
                                up to that many seconds waiting for a result

        Returns:
            True if a result was fetched, False if the queue was empty
        """
        try:
            if block_timeout is None:
                result = self._result_queue.get_nowait()
            else:
                result = self._result_queue.get(timeout=block_timeout)
        except Empty:
            return False
        if result.type == ResultType.LOGGING:
            self._log.logger.handle(result.record)
        return True

    def wait_shutdown(self):
        """
        Blocks while waiting for worker process to exit before returning
        Should call send_terminate() before wait_shutdown()

        Bounded so it can never hang indefinitely: the worker is force-terminated
        if it does not exit gracefully within WORKER_EXIT_TIMEOUT_SEC (e.g. a job
        stuck in an infinite loop, or a wedged result reader backing up the
        pipe). The daemon poller keeps draining the result queue in the
        background - independently of the event loop, which this synchronous call
        blocks - so the worker's result feeder never blocks on a full pipe while
        we wait for it to exit.
        """
        self._process.join(timeout=WORKER_EXIT_TIMEOUT_SEC)
        if self._process.is_alive():
            self._log.warning("Worker did not exit gracefully; terminating")
            self._process.terminate()
            self._process.join(timeout=WORKER_EXIT_TIMEOUT_SEC)
            if self._process.is_alive():
                self._process.kill()
                self._process.join()

        # Stop the poller now that the worker is gone. It is a daemon thread, so
        # even if it is wedged inside a partial multiprocess read (never
        # unblocked because the parent still holds the write fd) it can never
        # block interpreter exit or the event loop's executor shutdown.
        self._stopping.set()
        self._poll_thread.join(timeout=WORKER_EXIT_TIMEOUT_SEC)

        # If the poller stopped cleanly we are the sole reader, so flush any
        # results it left behind (e.g. context-destroy logs) before returning.
        if not self._poll_thread.is_alive():
            while self._drain_logging_results(block_timeout=None):
                pass

        self._task_queue.close()
        self._result_queue.close()
        self._task_queue.join_thread()
        self._result_queue.join_thread()
