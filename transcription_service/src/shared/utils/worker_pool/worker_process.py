"""
Defines WorkerProcess which handles worker process execution
"""

import time
from dataclasses import dataclass
from enum import IntEnum
from queue import Empty, Queue
from typing import Any

from src.shared.logger import Logger

from .job_context_interface import JobContextInterface
from .job_interface import JobInterface
from .job_result import JobException, JobStatistics, JobSuccess
from .result import (
    InitializeWorkerResult,
    JobExecutionResult,
    Result,
    StateChangeResult,
)
from .task import Task, TaskType
from .worker_state import WorkerState

NS_PER_MS = 10**6
NS_PER_SEC = 10**9


class _JobState(IntEnum):
    """
    Represents the current state of a job

    SLEEPING    - Job has already executed within the current period and
                    next period has not begun
    READY       - Job has not be executed within the current period
    ERRORED     - Job encountered an error and should be be rescheduled

    No Running state because currently running job blocks
    execution of anything else (no concurrency)
    """

    SLEEPING = 0
    READY = 1
    ERRORED = 2


@dataclass
class _JobEntry:
    """
    Holds relevant information about a job when assigned to worker process
    """

    job_id: int
    state: _JobState
    period_ms: int
    # Beginning of next period based on time.perf_counter_ns()
    period_start_ns: int
    context_ids: tuple[int, ...]
    buffer: list[Any]
    job: JobInterface[Any, Any, Any]


class _JobContextTable:
    """
    Helper class for managing context instances
    Automatically creates context instances when fetched if instance isn't already created
    """

    def __init__(
        self, logger: Logger, context_def: dict[int, JobContextInterface[Any]]
    ):
        """
        Args:
            context_def - Mapping from context_id (int) to context definitions
                            implementing JobContextInterface
        """
        self._log = logger
        self._context_def = context_def
        self._instance_table: dict[int, Any] = {}

    def get(self, context_id: int | None):
        """
        Fetches the corresponding context_id, creating context instance if not already created

        Args:
            context_id  - context_id to fetch, None if no context is needed

        Returns:
            ContextInstance of corresponding context_id

        Raises:
            KeyError if context_id is not found in context_def map
        """
        if context_id is None:
            return None
        if context_id not in self._context_def:
            raise KeyError("Invalid Context Id")

        log = self._log.child({"context_id": context_id})
        if context_id in self._instance_table:
            return self._instance_table[context_id]

        instance = self._context_def[context_id].create(log)
        self._instance_table[context_id] = instance
        return instance

    def destroy_unused(self, active_context_ids: set[int]):
        """
        Destroys context instances that are not in use.

        Args:
            active_context_ids  - Set of in use context_ids that should be kept
        """
        for context_id in list(self._instance_table.keys()):
            if context_id in active_context_ids:
                continue

            log = self._log.child({"context_id": context_id})

            instance = self._instance_table[context_id]
            self._context_def[context_id].destroy(log, instance)
            del self._instance_table[context_id]


class WorkerProcess:
    """
    Class to encapsulate worker process execution logic
    """

    def __init__(
        self,
        logger: Logger,
        task_queue: Queue[Task],
        result_queue: Queue[Result],
        context_def: dict[int, JobContextInterface[Any]],
    ):
        """
        Args:
            logger          - Application logger
            task_queue      - Read only queue for fetching admin tasks from main process
            result_queue    - Write only queue for pushing results to main process
            context_def     - Mapping from context id to context definitions
        """
        self._log = logger

        self._last_state_change = time.perf_counter_ns()
        self._state = WorkerState.ADMIN

        self._task_queue = task_queue
        self._result_queue = result_queue

        self._context_table = _JobContextTable(logger, context_def)
        self._job_entries: dict[int, _JobEntry] = {}

        self._should_exit = False

    def _set_state(self, state: WorkerState):
        """
        Updates the current state of the worker and updates statistics

        Args:
            state   - State to change worker to
        """
        if self._state == state:
            return

        prev_time = self._last_state_change
        curr_time = time.perf_counter_ns()

        # Update statistics
        time_elapsed_ns = curr_time - prev_time
        self._result_queue.put(StateChangeResult(self._state, time_elapsed_ns))

        # Update state
        self._last_state_change = curr_time
        self._state = state

    def _get_admin_task(self, block: bool, timeout: float | None):
        """
        Helper function for fetching task from task queue that removes the need for try/except
        Handles timeout or empty queue by returning None (task_queue never has None in it)

        Args:
            block   - Same as block argument for Queue.get
            timeout - Same as timeout argument for Queue.get

        Returns:
            task if task queue has a task, None if task queue is empty
        """
        try:
            return self._task_queue.get(block=block, timeout=timeout)
        except Empty:
            return None

    def _execute_admin_task(self, task: Task):
        """
        Determines the type of task provided and executes it

        Args:
            task    - Admin task to execute
        """
        if task.type == TaskType.TERMINATE_WORKER:
            self._log.info("Terminating worker")
            self._context_table.destroy_unused(set())
            self._should_exit = True
        elif task.type == TaskType.QUEUE_DATA:
            self._job_entries[task.job_id].buffer.extend(task.data)
        elif task.type == TaskType.DEREGISTER_JOB:
            self._log.info(f"Deregistering job: {task.job_id}")
            del self._job_entries[task.job_id]
        elif task.type == TaskType.REGISTER_JOB:
            self._log.info(f"Registering job: {task.job_id}")
            self._job_entries[task.job_id] = _JobEntry(
                job_id=task.job_id,
                state=_JobState.SLEEPING,
                period_ms=task.period_ms,
                period_start_ns=(
                    time.perf_counter_ns() + task.period_ms * NS_PER_MS
                ),
                context_ids=task.context_ids,
                buffer=[],
                job=task.job,
            )

    def _cleanup_unused_context(self):
        """
        Destroys all context instances that aren't in use by a job
        """
        self._log.debug("Cleaning up unused context")
        active_context_ids = set[int]()
        for entry in self._job_entries.values():
            active_context_ids.update(entry.context_ids)

        self._context_table.destroy_unused(active_context_ids)

    def _execute_job(self, job_id: int):
        """
        Executes the given job

        Args:
            job_id  - Job id of job to execture
        """
        job_scheduled_time_ns = time.perf_counter_ns()

        entry = self._job_entries[job_id]
        logger = self._log.child({"job_id": job_id})

        # Initialize job contexts
        try:
            contexts = tuple(map(self._context_table.get, entry.context_ids))
        # Worker should catch all exceptions and push to main process to be handled
        # pylint: disable=broad-exception-caught
        except Exception as error:
            stats = JobStatistics(
                period_start_ns=entry.period_start_ns,
                job_scheduled_time_ns=job_scheduled_time_ns,
                start_execute_time_ns=time.perf_counter_ns(),
                complete_time_ns=time.perf_counter_ns(),
            )
            self._result_queue.put(
                JobExecutionResult(job_id, JobException(error, stats))
            )
            entry.state = _JobState.ERRORED
            return

        # Execute job
        start_execute_time_ns = time.perf_counter_ns()
        try:
            batch = entry.buffer
            entry.buffer = []

            result = entry.job.process_batch(logger, contexts, batch)

            stats = JobStatistics(
                period_start_ns=entry.period_start_ns,
                job_scheduled_time_ns=job_scheduled_time_ns,
                start_execute_time_ns=start_execute_time_ns,
                complete_time_ns=time.perf_counter_ns(),
            )
            self._result_queue.put(
                JobExecutionResult(job_id, JobSuccess(result, stats))
            )
        # Worker should catch all exceptions and push to main process to be handled
        # pylint: disable=broad-exception-caught
        except Exception as error:
            stats = JobStatistics(
                period_start_ns=entry.period_start_ns,
                job_scheduled_time_ns=job_scheduled_time_ns,
                start_execute_time_ns=start_execute_time_ns,
                complete_time_ns=time.perf_counter_ns(),
            )
            self._result_queue.put(
                JobExecutionResult(job_id, JobException(error, stats))
            )
            entry.state = _JobState.ERRORED
            return

        # Update job state
        entry.state = _JobState.SLEEPING
        curr_time = time.perf_counter_ns()

        while entry.period_start_ns < curr_time:
            entry.period_start_ns += entry.period_ms * NS_PER_MS

    def _scheduler_edf(self):
        """
        Determines next job to execute based on Earliest Deadline First scheduling policy

        Returns:
            job_id to run or None if no jobs are ready
        """
        earliest_job = None
        earliest_deadline = None

        for entry in self._job_entries.values():
            if entry.state != _JobState.READY:
                continue

            deadline_ns = entry.period_start_ns + entry.period_ms * NS_PER_MS
            if earliest_deadline is None or earliest_deadline > deadline_ns:
                earliest_deadline = deadline_ns
                earliest_job = entry.job_id

        return earliest_job

    def _scheduler(self):
        """
        Updates job_entries and gets next job to execute or time to idle for if no jobs are ready

        Returns:
            (int, None)     where the int is the job_id of the next job to execute
            (None, float)   where the int is the period of time (seconds) to idle
                                before attempting to schedule again
            (None, None)    if no jobs are registered (should idle indefinitely)
        """
        curr_time = time.perf_counter_ns()

        # The earliest time that a currently sleeping task becomes ready
        ready_time_ns = None

        for entry in self._job_entries.values():
            if entry.state != _JobState.SLEEPING:
                continue

            # Mark all jobs with periods that started as ready
            # This is done before determining which job to schedule to ensure
            # all ready jobs are correctly identified
            if entry.period_start_ns < curr_time:
                entry.state = _JobState.READY

            if ready_time_ns is None or ready_time_ns > entry.period_start_ns:
                ready_time_ns = entry.period_start_ns

        if (next_job_id := self._scheduler_edf()) is not None:
            return next_job_id, None

        idle_time = None
        if ready_time_ns is not None:
            idle_time = (ready_time_ns - curr_time) / NS_PER_SEC
        return None, idle_time

    def execution_loop(self):
        """
        Main execution loop for worker process
        Continuously fetches admin tasks, schedules jobs, and executes jobs
        Returns when TerminateWorker task is received and currently executing job finishes
        """
        self._result_queue.put(InitializeWorkerResult())

        while True:
            self._set_state(WorkerState.ADMIN)
            # Perform all queued admin tasks
            self._log.debug("Performing admin tasks")
            while True:
                if self._should_exit:
                    return

                task = self._get_admin_task(block=False, timeout=None)
                if task is None:
                    break

                self._execute_admin_task(task)

            # Cleaning up unused context is also an admin task
            self._cleanup_unused_context()

            # Determine next job to run or how long to idle for
            job_id, idle_time = self._scheduler()

            if job_id is not None:
                self._log.info(f"Executing job_id: {job_id}")
                self._set_state(WorkerState.BUSY)
                self._execute_job(job_id)
            else:
                self._set_state(WorkerState.IDLE)
                self._log.debug(f"Idling for {idle_time} seconds")

                # Idle by blocking on task queue since only new admin
                # tasks would wake worker from idle
                task = self._get_admin_task(block=True, timeout=idle_time)

                # Execute this admin task here so it isn't lost
                if task is not None:
                    self._set_state(WorkerState.ADMIN)
                    self._execute_admin_task(task)
