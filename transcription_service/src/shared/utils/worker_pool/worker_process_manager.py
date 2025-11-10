"""
Defines WorkerProcessManager that manages main process communication with WorkerProcess
"""

import asyncio
import logging
from collections import deque
from queue import Queue
from typing import Any, Callable, Generic, TypeVar

import multiprocess as mp

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
)
from .worker_log_handler import WorkerLogHandler
from .worker_process import WorkerProcess
from .worker_state import WorkerState

NS_PER_SEC = 1000000000

C = TypeVar("C")
D = TypeVar("D")
R = TypeVar("R")


class JobHandle(Generic[D, R], EventEmitter):
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
        deregister: Callable[..., None],
    ):
        """
        Args:
            worker_id   - Worker id of worker that job is registered to
            job_id      - Registered job id
            queue_data  - Callback function to queue data to be processed
            deregister  - Callback function to deregister job
        """
        super().__init__()

        self._worker_id = worker_id
        self._job_id = job_id

        self._queue_data = queue_data
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

    def deregister(self) -> None:
        """
        Deregisters job from worker
        Does nothing if job has already been deregistered
        """
        if not self._deregister:
            return
        self._deregister()

        self._queue_data = None
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
        self._admin_time_ns = 0
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
        if state == WorkerState.ADMIN:
            self._admin_time_ns += increment_ns
        elif state == WorkerState.IDLE:
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
        context_def: dict[int, JobContextInterface[Any]],
        log_level: int,
        logger_context: dict[str, Any],
    ):
        """
        Entrypoint for worker process
        Creates logger and initializes WorkerProcess class

        Args:
            task_queue      - Read only queue for fetching admin tasks from main process
            result_queue    - Write only queue for pushing results to main process
            context_def     - Mapping from context id to context definitions
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

        return WorkerProcess(
            log, task_queue, result_queue, context_def
        ).execution_loop()

    @property
    def utilization(self):
        """
        Gets current rolling utilization of WorkerProcess
        """
        return self._rolling_utilization.utilization

    @property
    def active_context_ids(self):
        """
        Gets set of context_ids that are actively used by jobs
        """
        return set(self._job_context_ids.values())

    def __init__(
        self,
        logger: Logger,
        worker_id: int,
        context_def: dict[int, JobContextInterface[Any]],
        rolling_utilization_window_sec: float,
    ):
        """
        Args:
            logger                          - Application logger
            worker_id                       - Unique identifier for worker
            context_def                     - Mapping from context id to context definitions
            rolling_utilization_window_sec  - Length of rolling utilization window in seconds
        """
        self._log = logger.child({"worker_id": worker_id})
        self._worker_id = worker_id

        self._rolling_utilization = _RollingUtilization(
            int(rolling_utilization_window_sec * NS_PER_SEC)
        )

        self._next_job_id = 0
        self._context_def = context_def
        self._registered_job_handles: dict[int, JobHandle[Any, Any]] = {}
        self._job_context_ids: dict[int, int | None] = {}

        # False positive
        # pylint: disable=no-member
        ctx = mp.get_context("spawn")

        self._manager = ctx.Manager()
        self._task_queue: Queue[Task] = self._manager.Queue()
        self._result_queue: Queue[Result] = self._manager.Queue()

        self._process = ctx.Process(
            target=WorkerProcessManager._worker_function,
            args=(
                self._task_queue,
                self._result_queue,
                context_def,
                self._log.logger.level,
                self._log.context,
            ),
        )
        self._process.start()

        # Wait for initialization result that indicates worker is ready to accept jobs
        result = self._result_queue.get(block=True)
        if result.type != ResultType.INITIALIZE_WORKER:
            raise RuntimeError("Failed to start worker process")

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
        self, context_id: int | None, period_ms: int, job: JobInterface[C, D, R]
    ) -> JobHandle[D, R]:
        """
        Registers a new job with WorkerProcess

        Args:
            context_id      - Context id of context to provide to Job, can be None for no context
            period_ms       - Frequency at which job should be run
            job             - Definition of job to register

        Returns:
            JobHandle for registered job

        Raises:
            KeyError if invalid context id is provided
        """
        if context_id is not None and context_id not in self._context_def:
            raise KeyError("Invalid Context Id")

        job_id = self._next_job_id
        self._next_job_id += 1

        self._job_context_ids[job_id] = context_id
        self._task_queue.put(
            RegisterJobTask(job_id, context_id, period_ms, job)
        )

        def _queue_data(data: list[D]):
            self._task_queue.put(QueueDataTask(job_id, data))

        def _deregister():
            self._task_queue.put(DeregisterJobTask(job_id))

            del self._registered_job_handles[job_id]
            del self._job_context_ids[job_id]

        job_handle = JobHandle[D, R](
            self._worker_id, job_id, _queue_data, _deregister
        )
        self._registered_job_handles[job_id] = job_handle
        return job_handle

    def send_terminate(self):
        """
        Send signal to gracefully shut down worker process

        Does not wait for process to exit
        Call wait_shutdown() after send_terminate() to wait for process to exit
        """
        # Stop the result polling task
        self._result_poller_task.cancel()

        self._task_queue.put(TerminateWorkerTask())

    def wait_shutdown(self):
        """
        Blocks while waiting for worker process to exit before returning
        Should call send_terminate() before wait_shutdown()
        """
        self._process.join()
        self._manager.shutdown()
