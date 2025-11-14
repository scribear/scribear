"""
Defines WorkerPool for managing multiple WorkerProcessManagers
"""

from itertools import product
from typing import Any, TypeVar, cast

from src.shared.logger import Logger
from src.shared.utils.worker_pool.worker_process_manager import (
    JobHandle,
    WorkerProcessManager,
)

from .job_context_interface import JobContextInterface
from .job_interface import JobInterface

C = TypeVar("C", bound=tuple)
D = TypeVar("D")
R = TypeVar("R")


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

    def _get_min_utilization(self):
        """
        Gets the process id with minimum utilization
        """
        min_util = None
        min_util_process = None
        for process_id, process in enumerate(self._processes):
            if min_util is None or min_util > process.utilization:
                min_util = process.utilization
                min_util_process = process_id
        return cast(int, min_util_process)

    def _context_max_active_reached(self, context_id: int):
        """
        Determine if a given context_id has reached maximum active instances allowed

        Args:
            context_id      - Context id to check

        Returns:
            True if maximum is reached, False if not
        """
        max_instances = self._context_def[context_id].max_instances
        if max_instances == -1:
            return False

        count = 0
        for process in self._processes:
            if context_id in process.active_context_ids:
                count += 1
        return count >= max_instances

    def _context_ids_are_compatible(self, context_ids: tuple[int, ...]):
        """
        Determines if group of context ids are compatible
        As in none have negative affinity with another

        Args:
            context_ids     - Group of context ids to check

        Returns:
            True if context_ids are compatible, False if not
        """
        for context_id in context_ids:
            other_tags = set[str]()
            for other_id in context_ids:
                if other_id != context_ids:
                    other_tags.update(self._context_def[other_id].tags)

            if self._context_def[context_id].negative_affinity in other_tags:
                return False
        return True

    def _has_negative_affinity(self, context_id: int, process_id: int):
        """
        Determines if given context id has negative affinity with active contexts on process

        Args:
            context_id      - Context id to check
            process_id      - Process id to to check

        Returns:
            True if context id has negative affinity with process, False if not
        """
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

    def _assignment_is_valid(
        self, context_ids: tuple[int, ...], process_id: int
    ):
        """
        Determinie if a given group of context ids can be assigned to a given process

        Args:
            context_ids     - Group of context ids to check
            process_id      - Process id of process to check

        Returns:
            True if context ids can be assigned, False if not
        """
        # Process needs to support every context_id in group
        for context_id in context_ids:
            # context_id/process_id is disqualified if pair has negative affinity
            if self._has_negative_affinity(context_id, process_id):
                return False

            # context_id/process_id id disqualified if it requires created new
            # context instance when max instance count is already reached
            if (
                self._context_max_active_reached(context_id)
                and context_id
                not in self._processes[process_id].active_context_ids
            ):
                return False
        return True

    def _get_potential_assignments(
        self, matched_contexts: tuple[set[int], ...]
    ):
        """
        Determine potential valid assignments for job given set of context_id matches

        Args:
            matched_contexts    - Group of lists, with each list matching set of
                                    context ids that matched corresponding context tag

        Returns:
            List of process_ids and tuples of context_ids that are valid assignments
        """
        potential_assignments: list[tuple[int, tuple[int, ...]]] = []
        for context_ids in product(*matched_contexts):
            if not self._context_ids_are_compatible(context_ids):
                print(context_ids)
                continue

            for process_id in range(len(self._processes)):
                if self._assignment_is_valid(context_ids, process_id):
                    potential_assignments.append((process_id, context_ids))
        return potential_assignments

    def _assign_process(
        self, context_tags: tuple[str, ...]
    ) -> tuple[int, tuple[int, ...]]:
        """
        Determine which process to assign a job with given context tags to
        Considers all valid combinations of context_ids matching tags and processes
        and selects the pair with best score.

        Args:
            context_tags        - Group of tags corresponding to the requested context of the job

        Returns:
            Process id and tuple of context_ids to assign to it
        """
        # If no context is required, select process with minimum utilization
        if len(context_tags) == 0:
            return (self._get_min_utilization(), ())

        # Map each context tag to set of context ids
        matched_contexts = tuple(map(self.get_context_ids_by_tag, context_tags))
        # If a tag doesn't match any ids, we cannot provide assign a worker
        for i, context_ids in enumerate(matched_contexts):
            if len(context_ids) == 0:
                raise KeyError(
                    f"context tag: {context_tags[i]} matched 0 context definitions"
                )

        best_score = None
        best_assignment = None
        for process_id, context_ids in self._get_potential_assignments(
            matched_contexts
        ):
            # Compute the cost of creating contexts on process
            creation_cost = 0
            # Only use unique context ids to compute cost
            for context_id in set(context_ids):
                is_active_context = (
                    context_id in self._processes[process_id].active_context_ids
                )
                if not is_active_context:
                    creation_cost += self._context_def[context_id].creation_cost

            utilization = self._processes[process_id].utilization

            score = 1 - utilization
            score -= creation_cost

            if best_score is None or score > best_score:
                best_score = score
                best_assignment = (process_id, context_ids)

        if best_assignment is None:
            raise RuntimeError(
                f"No valid assignment cound be found for context tags: {context_tags}"
            )
        return best_assignment

    def register_job(
        self,
        context_tags: tuple[str, ...],
        period_ms: int,
        job: JobInterface[C, D, R],
    ) -> JobHandle[D, R]:
        """
        Registers a new job with WorkerPool

        Args:
            context_tags    - Context tags of context instances to provide to Job, can be empty
            period_ms       - Frequency at which job should be run
            job             - Definition of job to register

        Returns:
            JobHandle for registered job

        Raises:
            KeyError if invalid context id is provided
            RuntimeError if job could not be assigned to a worker
        """
        process_id, context_id = self._assign_process(context_tags)
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
