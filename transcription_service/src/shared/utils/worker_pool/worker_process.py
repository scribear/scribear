"""
Defines WorkerProcess which handles worker process execution
"""

import time
from dataclasses import dataclass
from enum import IntEnum
from queue import Empty
from typing import Any

from multiprocess.queues import Queue

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


def _drain_counters(job: JobInterface[Any, Any, Any, Any], log: Logger):
    """
    Collects the counters a job accumulated during one execution

    Args:
        job     - Job that just executed
        log     - Application logger

    Returns:
        Counter name to per-execution delta, empty if the job reports none

    Counters are out-of-band bookkeeping, so a job with a broken override must
    not lose the result it just produced. Failures are logged and swallowed.
    """
    try:
        return job.drain_counters()
    # pylint: disable=broad-exception-caught
    except Exception as error:
        log.error(f"Job counter drain failed: {error}")
        return {}


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
class _BufferSegment:
    """
    A contiguous batch of data optionally followed by a config update

    The job's process_batch is called with `data`, then if `trailing_config`
    is not None, job.update_config is called with it before the next segment
    is processed.
    """

    data: list[Any]
    trailing_config: Any = None
    has_trailing_config: bool = False


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
    buffer: list[_BufferSegment]
    job: JobInterface[Any, Any, Any, Any]
    # Cached child logger to avoid rebuilding every batch
    log: Logger


class WorkerProcess:
    """
    Class to encapsulate worker process execution logic
    """

    def __init__(
        self,
        logger: Logger,
        task_queue: Queue[Task],
        result_queue: Queue[Result],
        context_defs: dict[int, JobContextInterface[Any]],
    ):
        """
        Args:
            logger          - Application logger
            task_queue      - Read only queue for fetching admin tasks from main process
            result_queue    - Write only queue for pushing results to main process
            context_defs    - Mapping from context id to context definitions assigned
                                to this worker. All contexts are created at startup.
        """
        self._log = logger

        self._last_state_change = time.perf_counter_ns()
        self._state = WorkerState.BUSY

        self._task_queue = task_queue
        self._result_queue = result_queue

        self._context_defs = context_defs
        self._contexts: dict[int, Any] = {}
        self._job_entries: dict[int, _JobEntry] = {}

        self._should_exit = False

    def _initialize_contexts(self):
        """
        Eagerly create every context assigned to this worker before the
        execution loop accepts any jobs. Errors are returned to the caller
        so it can report them to the main process and abort startup.

        Returns:
            None on success, error string describing the failed context on failure
        """
        for context_id, context_def in self._context_defs.items():
            log = self._log.child({"context_id": context_id})
            try:
                self._contexts[context_id] = context_def.create(log)
            # pylint: disable=broad-exception-caught
            except Exception as error:
                return f"context_id={context_id}: {error}"
        return None

    def _destroy_contexts(self):
        """
        Destroy every context instance owned by this worker
        Called once during shutdown - context lifetime matches worker lifetime
        """
        for context_id, instance in self._contexts.items():
            log = self._log.child({"context_id": context_id})
            self._context_defs[context_id].destroy(log, instance)
        self._contexts.clear()

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

    def _append_data(self, job_id: int, data: list[Any]):
        """
        Append data to the job's buffer, extending the open segment or
        starting a new one if the last segment has been closed by a config update

        Args:
            job_id  - Job id of job to append data to
            data    - Data to append
        """
        buffer = self._job_entries[job_id].buffer
        if not buffer or buffer[-1].has_trailing_config:
            buffer.append(_BufferSegment(data=list(data)))
        else:
            buffer[-1].data.extend(data)

    def _append_config_update(self, job_id: int, config: Any):
        """
        Mark the job's open segment as closed by a config update, or start
        a new segment with that trailing config if the last is already closed

        Args:
            job_id  - Job id of job to append config update to
            config  - New config to apply after the open segment
        """
        buffer = self._job_entries[job_id].buffer
        if not buffer or buffer[-1].has_trailing_config:
            buffer.append(
                _BufferSegment(
                    data=[], trailing_config=config, has_trailing_config=True
                )
            )
        else:
            buffer[-1].trailing_config = config
            buffer[-1].has_trailing_config = True

    def _execute_admin_task(self, task: Task):
        """
        Determines the type of task provided and executes it

        Args:
            task    - Admin task to execute
        """
        if task.type == TaskType.TERMINATE_WORKER:
            self._log.info("Terminating worker")
            self._destroy_contexts()
            self._should_exit = True
        elif task.type == TaskType.QUEUE_DATA:
            self._append_data(task.job_id, task.data)
        elif task.type == TaskType.UPDATE_JOB_CONFIG:
            self._append_config_update(task.job_id, task.config)
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
                log=self._log.child({"job_id": task.job_id}),
            )

    def _execute_job(self, job_id: int):
        """
        Executes the given job

        Walks the job's buffer segment-by-segment, calling process_batch on each
        segment's data and update_config between segments where a trailing config
        update was queued. Each process_batch call emits its own JobExecutionResult;
        update_config emits only on error.

        Args:
            job_id  - Job id of job to execture
        """
        job_scheduled_time_ns = time.perf_counter_ns()

        entry = self._job_entries[job_id]
        log = entry.log

        # Contexts are pre-initialized at worker startup so this is just a lookup
        contexts = tuple(self._contexts[cid] for cid in entry.context_ids)

        # Snapshot and clear the buffer. If empty, run a single empty batch to
        # preserve existing semantics: process_batch is called every period even
        # when no data has been queued.
        segments = entry.buffer if entry.buffer else [_BufferSegment(data=[])]
        entry.buffer = []

        for seg in segments:
            start_execute_time_ns = time.perf_counter_ns()
            try:
                result = entry.job.process_batch(log, contexts, seg.data)
            # pylint: disable=broad-exception-caught
            except Exception as error:
                stats = JobStatistics(
                    period_start_ns=entry.period_start_ns,
                    job_scheduled_time_ns=job_scheduled_time_ns,
                    start_execute_time_ns=start_execute_time_ns,
                    complete_time_ns=time.perf_counter_ns(),
                )
                # Drained on the failure path too: a counter incremented
                # immediately before the raise - audio-too-fast is exactly
                # that - would otherwise never leave the worker.
                self._result_queue.put(
                    JobExecutionResult(
                        job_id,
                        JobException(
                            error, stats, _drain_counters(entry.job, log)
                        ),
                    )
                )
                entry.state = _JobState.ERRORED
                return

            stats = JobStatistics(
                period_start_ns=entry.period_start_ns,
                job_scheduled_time_ns=job_scheduled_time_ns,
                start_execute_time_ns=start_execute_time_ns,
                complete_time_ns=time.perf_counter_ns(),
            )
            self._result_queue.put(
                JobExecutionResult(
                    job_id,
                    JobSuccess(result, stats, _drain_counters(entry.job, log)),
                )
            )

            if not seg.has_trailing_config:
                continue

            # Apply trailing config update between segments
            start_config_time_ns = time.perf_counter_ns()
            try:
                entry.job.update_config(log, contexts, seg.trailing_config)
            # pylint: disable=broad-exception-caught
            except Exception as error:
                stats = JobStatistics(
                    period_start_ns=entry.period_start_ns,
                    job_scheduled_time_ns=job_scheduled_time_ns,
                    start_execute_time_ns=start_config_time_ns,
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
        Eagerly creates every assigned context, then enters the scheduling loop.
        Returns when TerminateWorker task is received and currently executing job finishes.
        Returns early without entering the loop if context initialization fails.
        """
        init_error = self._initialize_contexts()
        if init_error is not None:
            self._log.error(
                f"Worker context initialization failed: {init_error}"
            )
            self._result_queue.put(InitializeWorkerResult(error=init_error))
            return

        self._result_queue.put(InitializeWorkerResult())

        while True:
            if self._should_exit:
                return

            while True:
                task = self._get_admin_task(block=False, timeout=None)
                if task is None:
                    break
                self._execute_admin_task(task)
                if self._should_exit:
                    return

            job_id, idle_time = self._scheduler()

            if job_id is not None:
                self._set_state(WorkerState.BUSY)
                self._execute_job(job_id)
            else:
                self._set_state(WorkerState.IDLE)

                # Idle by blocking on task queue since only new admin
                # tasks would wake worker from idle
                task = self._get_admin_task(block=True, timeout=idle_time)

                # Execute this admin task here so it isn't lost
                if task is not None:
                    self._set_state(WorkerState.BUSY)
                    self._execute_admin_task(task)
