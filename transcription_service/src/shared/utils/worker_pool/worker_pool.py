"""
Defines WorkerPool for managing multiple WorkerProcessManagers
"""

from dataclasses import dataclass
from itertools import product
from typing import Any, TypeVar, cast

from src.shared.logger import Logger
from src.shared.utils.worker_pool.worker_process_manager import (
    ROLLING_UTILIZATION_WINDOW_NS,
    JobHandle,
    WorkerProcessManager,
    WorkerSnapshot,
)

from .job_context_interface import JobContextInterface
from .job_interface import JobInterface
from .job_result import JobObserver

C = TypeVar("C", bound=tuple)
D = TypeVar("D")
R = TypeVar("R")
Conf = TypeVar("Conf")


@dataclass
class ContextAssignment:
    """
    Assigns a context definition to a specific set of workers
    Each listed worker will eagerly create an instance of this context at startup.
    """

    context_def: JobContextInterface[Any]
    worker_ids: list[int]


class WorkerPool:
    """
    Interface for managing multiple WorkerProcessManagers
    Assigns contexts to workers up front and routes jobs to workers that own
    a matching context with lowest utilization.

    Usage
    ```
    class Context(JobContextInterface[int]):
        def __init__(self):
            super().__init__(tags=["some_context"])

        def create(self, log: Logger) -> int:
            return 42

        def destroy(self, log: Logger, context: int) -> None:
            return


    class Job(JobInterface[tuple[int], int, int]):
        def process_batch(
            self, log: Logger, contexts: tuple[int], batch: list[int]
        ) -> int:
            return sum(batch) + contexts[0]


    pool = WorkerPool(
        logger,
        num_workers=2,
        contexts=[ContextAssignment(Context(), worker_ids=[0, 1])],
    )

    handle = pool.register_job(("some_context",), period_ms=100, job=Job())
    handle.queue_data([1, 2, 3])
    handle.on(handle.JobResultEvent, lambda result: print(result))

    # ...

    handle.deregister()
    pool.shutdown()
    ```
    """

    def __init__(
        self,
        logger: Logger,
        num_workers: int,
        contexts: list[ContextAssignment],
        rolling_utilization_window_ns: int = ROLLING_UTILIZATION_WINDOW_NS,
        job_observer: JobObserver | None = None,
    ):
        """
        Args:
            logger      - Application logger
            num_workers - Number of worker processes to spawn
            contexts    - Context assignments. Each context_def is created on
                            every worker listed in its worker_ids. Position in
                            the list determines the context_id.
            rolling_utilization_window_ns - Override for the per-worker utilization
                                              smoothing window (production should
                                              use the default)
            job_observer - Optional callback invoked for every completed job
                            execution on every worker

        Raises:
            ValueError      if num_workers is 0 or worker_ids reference an invalid worker
            RuntimeError    if any worker fails to initialize a context
        """
        if num_workers <= 0:
            raise ValueError("num_workers must be at least 1")

        # Assign each context to its target workers (position in `contexts` is context_id)
        per_worker_defs: list[dict[int, JobContextInterface[Any]]] = [
            {} for _ in range(num_workers)
        ]
        for context_id, assignment in enumerate(contexts):
            for worker_id in assignment.worker_ids:
                if not 0 <= worker_id < num_workers:
                    raise ValueError(
                        f"Context {context_id} references invalid worker_id={worker_id}"
                    )
                per_worker_defs[worker_id][context_id] = assignment.context_def

        self._contexts = contexts
        self._processes = [
            WorkerProcessManager(
                logger,
                worker_id,
                per_worker_defs[worker_id],
                rolling_utilization_window_ns,
                job_observer,
            )
            for worker_id in range(num_workers)
        ]

        # Pre-compute tag -> set of context_ids that have it for fast routing
        self._tag_to_context_ids: dict[str, set[int]] = {}
        for context_id, assignment in enumerate(contexts):
            for tag in assignment.context_def.tags:
                self._tag_to_context_ids.setdefault(tag, set()).add(context_id)

    @property
    def num_workers(self) -> int:
        """
        Gets number of worker processes in the pool
        """
        return len(self._processes)

    def worker_snapshots(self) -> list[WorkerSnapshot]:
        """
        Gets a point-in-time view of every worker's load, in worker id order

        Side effect free, so it is safe to call from a request handler.
        """
        return [process.snapshot() for process in self._processes]

    def load_for_tags(
        self, context_tags: tuple[str, ...]
    ) -> list[WorkerSnapshot]:
        """
        Gets the live workers that own EVERY given context tag, with their load

        The read-only counterpart to `_assign_process`, which answers the same
        routing question but *raises* when a tag matches nothing or no single
        worker holds them all. Health reporting must never raise - a provider
        whose contexts are missing is precisely the condition being reported,
        so it has to come back as data rather than a 500.

        Args:
            context_tags    - Tags the provider's contexts must all match

        Returns:
            Snapshots of the alive workers that own every tag, in worker id
            order. Empty means this provider's model is loaded on no live
            worker, which is the mis-set worker_ids/tags failure. Also empty
            for an empty tag tuple, since a provider that needs no context
            (remote or debug) has no owning workers to report.
        """
        if not context_tags:
            return []

        matched_per_tag = [
            self._tag_to_context_ids.get(tag, set()) for tag in context_tags
        ]
        # A tag matching no context definition at all cannot be satisfied by
        # any combination, so short circuit before the product.
        if any(not ids for ids in matched_per_tag):
            return []

        owners: set[int] = set()
        for context_ids in product(*matched_per_tag):
            owners |= self._workers_with_contexts(context_ids)

        return [
            self._processes[worker_id].snapshot()
            for worker_id in sorted(owners)
            if self._processes[worker_id].alive
        ]

    def get_context_ids_by_tag(self, tag: str) -> set[int]:
        """
        Gets set of context_ids that have the given tag

        Args:
            tag     - Tag to look up

        Returns:
            Set of context_ids that include this tag; empty if no match
        """
        return set(self._tag_to_context_ids.get(tag, set()))

    def _get_min_utilization(self):
        """
        Gets the worker id with minimum utilization
        """
        min_util = None
        min_util_process = None
        for process_id, process in enumerate(self._processes):
            if min_util is None or min_util > process.utilization:
                min_util = process.utilization
                min_util_process = process_id
        return cast(int, min_util_process)

    def _workers_with_contexts(self, context_ids: tuple[int, ...]) -> set[int]:
        """
        Find workers that own every context in the given group

        Args:
            context_ids     - Group of context_ids that must all live on the same worker

        Returns:
            Set of worker_ids that have all requested contexts initialized
        """
        unique = set(context_ids)
        worker_ids = set(range(len(self._processes)))
        for cid in unique:
            worker_ids &= self._processes_with_context(cid)
            if not worker_ids:
                break
        return worker_ids

    def _processes_with_context(self, context_id: int) -> set[int]:
        """
        Set of worker_ids that have the given context_id pinned to them
        """
        return {
            worker_id
            for worker_id, process in enumerate(self._processes)
            if context_id in process.context_ids
        }

    def _assign_process(
        self, context_tags: tuple[str, ...]
    ) -> tuple[int, tuple[int, ...]]:
        """
        Pick the worker for a job. Contexts are pinned so this just finds workers
        that own every required tag and picks the one with lowest utilization.

        Args:
            context_tags    - Tags the job's contexts must match (in order)

        Returns:
            (worker_id, context_ids tuple matching context_tags order)

        Raises:
            KeyError        if any tag matches no configured context
            RuntimeError    if no single worker holds a context for every tag
        """
        if len(context_tags) == 0:
            return (self._get_min_utilization(), ())

        matched_per_tag: list[set[int]] = []
        for tag in context_tags:
            ids = self._tag_to_context_ids.get(tag, set())
            if not ids:
                raise KeyError(
                    f"context tag: {tag} matched 0 context definitions"
                )
            matched_per_tag.append(ids)

        best_score = None
        best_assignment = None
        for context_ids in product(*matched_per_tag):
            worker_ids = self._workers_with_contexts(context_ids)
            for wid in worker_ids:
                score = 1 - self._processes[wid].utilization
                if best_score is None or score > best_score:
                    best_score = score
                    best_assignment = (wid, context_ids)

        if best_assignment is None:
            raise RuntimeError(
                f"No worker has a context for every tag in: {context_tags}"
            )
        return best_assignment

    def register_job(
        self,
        context_tags: tuple[str, ...],
        period_ms: int,
        job: JobInterface[C, D, R, Conf],
        label: str = "",
    ) -> JobHandle[D, R, Conf]:
        """
        Registers a new job with WorkerPool

        Args:
            context_tags    - Tags identifying which contexts the job needs, can be empty
            period_ms       - Frequency at which job should be run
            job             - Definition of job to register
            label           - Opaque grouping label reported to the job observer

        Returns:
            JobHandle for registered job

        Raises:
            KeyError        if any context_tag matches no configured context
            RuntimeError    if no worker has all required contexts together
        """
        process_id, context_ids = self._assign_process(context_tags)
        return self._processes[process_id].register_job(
            context_ids, period_ms, job, label
        )

    def shutdown(self):
        """
        Shuts down all WorkerProcesses
        Blocks while waiting for worker processes to exit before returning
        """
        for process in self._processes:
            process.send_terminate()
        for process in self._processes:
            process.wait_shutdown()
