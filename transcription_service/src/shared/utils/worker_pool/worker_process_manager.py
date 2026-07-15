"""
Defines WorkerProcessManager that manages main process communication with WorkerProcess
"""

import asyncio
import logging
from collections import deque
from queue import Empty
from typing import Any, Callable, Generic, TypeVar, cast

import multiprocess as mp
from multiprocess.queues import Queue

from src.shared.logger import ContextLogger, Logger
from src.shared.utils.event_emitter import Event, EventEmitter

from .job_context_interface import JobContextInterface
from .job_interface import JobInterface
from .job_result import JobException, JobSuccess
from .result import Result, ResultType
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

    def __init__(
        self,
        logger: Logger,
        worker_id: int,
        context_defs: dict[int, JobContextInterface[Any]],
        rolling_utilization_window_ns: int = ROLLING_UTILIZATION_WINDOW_NS,
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
        """
        self._log = logger.child({"worker_id": worker_id})
        self._worker_id = worker_id

        self._rolling_utilization = _RollingUtilization(
            rolling_utilization_window_ns
        )

        self._next_job_id = 0
        self._context_defs = context_defs
        self._registered_job_handles: dict[int, JobHandle[Any, Any, Any]] = {}

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
        # Drain log records that may arrive before the init result.
        while True:
            result = self._result_queue.get(block=True)
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

        # Start the asyncio task that polls for results from the workers
        self._result_poller_task = asyncio.create_task(self._poll_results())

    async def _poll_results(self):
        """
        Loop that continuously pulls from results queue and emits events when a result is received
        """
        while True:
            # Run the blocking `get()` call in a separate thread to avoid
            # blocking the asyncio event loop.
            result = await asyncio.to_thread(self._result_queue.get)

            if result.type == ResultType.LOGGING:
                self._log.logger.handle(result.record)
            elif result.type == ResultType.STATE_CHANGE:
                self._rolling_utilization.increment(
                    result.state, result.time_elapsed_ns
                )
            elif result.type == ResultType.JOB_EXECUTION:
                if result.job_id not in self._registered_job_handles:
                    continue
                job_handle = self._registered_job_handles[result.job_id]
                job_handle.emit(job_handle.JobResultEvent, result.result)

                if result.result.has_exception:
                    job_handle.deregister()

    def register_job(
        self,
        context_ids: tuple[int, ...],
        period_ms: int,
        job: JobInterface[C, D, R, Conf],
    ) -> JobHandle[D, R, Conf]:
        """
        Registers a new job with WorkerProcess

        Args:
            context_ids     - Context ids of context instances to provide to Job, can be empty
            period_ms       - Frequency at which job should be run
            job             - Definition of job to register

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

        job_handle = JobHandle[D, R, Conf](
            self._worker_id, job_id, _queue_data, _update_config, _deregister
        )
        self._registered_job_handles[job_id] = job_handle
        return job_handle

    def send_terminate(self):
        """
        Send signal to gracefully shut down worker process

        Does not wait for process to exit
        Call wait_shutdown() after send_terminate() to wait for process to exit
        """
        self._task_queue.put(TerminateWorkerTask())

    def wait_shutdown(self):
        """
        Blocks while waiting for worker process to exit before returning
        Should call send_terminate() before wait_shutdown()
        """
        self._process.join()

        # Cancel the async poller and drain any results the worker emitted
        # during shutdown (e.g. destroy logs) so callers see them.
        self._result_poller_task.cancel()
        while True:
            try:
                result = self._result_queue.get_nowait()
            except Empty:
                break
            if result.type == ResultType.LOGGING:
                self._log.logger.handle(result.record)

        self._task_queue.close()
        self._result_queue.close()
        self._task_queue.join_thread()
        self._result_queue.join_thread()
