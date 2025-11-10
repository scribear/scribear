"""
Defines WorkerPool for managing multiple WorkerProcessManagers
"""

from typing import Any, TypeVar, cast

from src.shared.logger import Logger
from src.shared.utils.worker_pool.worker_process_manager import (
    JobHandle,
    WorkerProcessManager,
)

from .job_context_interface import JobContextInterface
from .job_interface import JobInterface

C = TypeVar("C")
D = TypeVar("D")
R = TypeVar("R")

ACTIVE_CONTEXT_SCORE_BONUS = 0.1


class WorkerPool:
    """
    Interface for managing multiple WorkerProcessManagers
    Handles assigning jobs to processes

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


    # Create WorkerPool
    context_def: dict[int, JobContextInterface[Any]] = {0: Context()}
    rolling_utilization_window_sec = 5 * 60
    pool = WorkerPool(
        logger, 2, context_def, rolling_utilization_window_sec
    )

    # Register a job
    period_ms = 100
    handle = pool.register_job("some_context", period_ms, Job())

    # Queue data for job to process
    handle.queue_data([1, 2, 3])
    handle.queue_data([4, 5, 6])

    # Handle job results
    handle.on(handle.JobResultEvent, lambda result: print(result))  # Prints 63

    # Give job time to execute
    await asyncio.sleep(1)

    handle.deregister()

    # Shutdown pool
    pool.shutdown()
    ```
    """

    def __init__(
        self,
        logger: Logger,
        num_workers: int,
        context_def: dict[int, JobContextInterface[Any]],
        rolling_utilization_window_sec: float,
    ):
        if num_workers <= 0:
            raise ValueError("num_workers must be at least 1")

        self._processes = [
            WorkerProcessManager(
                logger, id, context_def, rolling_utilization_window_sec
            )
            for id in range(num_workers)
        ]

        self._context_def = context_def

    def get_context_ids_by_tag(self, tag: str):
        """
        Gets set of context_ids that with the given tag

        Args:
            tag         - Tag to select context definitions

        Returns:
            Set of context_id that have given tag
        """
        context_ids = set[int]()
        for context_id in self._context_def:
            if tag in self._context_def[context_id].tags:
                context_ids.add(context_id)
        return context_ids

    def tagged_context_is_instance(self, tag: str, instances: list[Any]):
        """
        Checks that all context definitions matching given tag is an
        instance of one of the given instances

        Args:
            tags        - Tag to select context definitions to check
            instances   - List of instance definitions to check against

        Returns:
            True if all matching context definitions is an instance of
            one of the given instances, False otherwise
        """
        context_ids = self.get_context_ids_by_tag(tag)
        for context_id in context_ids:
            matches_type = False
            for inst in instances:
                if isinstance(self._context_def[context_id], inst):
                    matches_type = True
                    break
            if not matches_type:
                return False
        return True

    def _context_max_active_reached(self, context_id: int):
        max_instances = self._context_def[context_id].max_instances
        if max_instances == -1:
            return False

        count = 0
        for process in self._processes:
            if context_id in process.active_context_ids:
                count += 1
        return count >= max_instances

    def _has_negative_affinity(self, context_id: int, process_id: int):
        tags = self._context_def[context_id].tags
        negative_affinity = self._context_def[context_id].negative_affinity

        # Set of tags for currently active contexts on process
        active_context_tags = set[str]()
        # Set of negative affinities for active contexts on process
        active_negative_affinity = set[str]()

        for active_id in self._processes[process_id].active_context_ids:
            if active_id is None:
                continue
            active_context_tags.update(self._context_def[active_id].tags)

            active_neg_tag = self._context_def[active_id].negative_affinity
            if active_neg_tag is not None:
                active_negative_affinity.add(active_neg_tag)

        # Ensure this context does not have negative affinity with the currently active contexts
        if negative_affinity in active_context_tags:
            return True
        # Ensure this currently active contexts does not have negative affinity with this context
        if not tags.isdisjoint(active_negative_affinity):
            return True
        return False

    def _assign_worker(self, context_tag: str | None) -> tuple[int, int | None]:
        # If no context is required, select process with minimum utilization
        if context_tag is None:
            min_util = None
            min_util_process = None
            for process_id, process in enumerate(self._processes):
                if min_util is None or min_util > process.utilization:
                    min_util = process.utilization
                    min_util_process = process_id
            return (cast(int, min_util_process), None)

        # Cannot schedule if no valid context ids are found
        context_ids = self.get_context_ids_by_tag(context_tag)
        if len(context_ids) == 0:
            raise KeyError(
                f"context tag: {context_tag} matched 0 context definitions"
            )

        # Determine potential valid assignments for job
        potential_assignments: list[tuple[int, int]] = []
        for context_id in context_ids:
            max_reached = self._context_max_active_reached(context_id)

            for process_id, process in enumerate(self._processes):
                # context_id/process_id is disqualified if pair has negative affinity
                if self._has_negative_affinity(context_id, process_id):
                    continue

                # context_id/process_id id disqualified if it requires created new
                # context instance when max instance count is already reached
                if max_reached and context_id not in process.active_context_ids:
                    continue

                potential_assignments.append((process_id, context_id))

        best_score = None
        best_assignment = None
        for process_id, context_id in potential_assignments:
            active_context = (
                context_id in self._processes[process_id].active_context_ids
            )
            utilization = self._processes[process_id].utilization

            score = 1 - utilization
            if active_context:
                score += ACTIVE_CONTEXT_SCORE_BONUS

            if best_score is None or score > best_score:
                best_score = score
                best_assignment = (process_id, context_id)

        if best_assignment is None:
            raise RuntimeError(
                f"No valid assignment cound be found for context tag: {context_tag}"
            )
        return best_assignment

    def register_job(
        self,
        context_tag: str | None,
        period_ms: int,
        job: JobInterface[C, D, R],
    ) -> JobHandle[D, R]:
        """
        Registers a new job with WorkerPool

        Args:
            context_id      - Context id of context to provide to Job, can be None for no context
            period_ms       - Frequency at which job should be run
            job             - Definition of job to register

        Returns:
            JobHandle for registered job

        Raises:
            KeyError if invalid context id is provided
            RuntimeError if job could not be assigned to a worker
        """
        process_id, context_id = self._assign_worker(context_tag)
        return self._processes[process_id].register_job(
            context_id, period_ms, job
        )

    def shutdown(self):
        """
        Shuts down all WorkerProcessses
        Blocks while waiting for worker processes to exit before returning
        """
        for process in self._processes:
            process.send_terminate()
        for process in self._processes:
            process.wait_shutdown()
