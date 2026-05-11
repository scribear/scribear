"""
Unit tests for WorkerPool
"""

from typing import Any
from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from pytest_mock import MockerFixture, MockType

from src.shared.logger import Logger
from src.shared.utils.worker_pool import (
    ContextAssignment,
    JobInterface,
    WorkerPool,
    WorkerProcessManager,
)

from .context_definitions import Context, LoggerContext, SlowContext

# Context IDs (positions in the contexts list)
CTX_CONTEXT = 0
CTX_LOGGER = 1
CTX_SLOW = 2


@pytest.fixture
def mock_logger():
    """
    Placeholder logger; WorkerPool just forwards it to WorkerProcessManagers (mocked)
    """
    return None


@pytest.fixture
def mock_wpm_instances(mocker: MockerFixture):
    """
    Three mock WorkerProcessManager instances. Tests override .utilization and
    .context_ids per test to drive routing behavior.
    """
    instances = [mocker.MagicMock(spec=WorkerProcessManager) for _ in range(3)]
    for inst in instances:
        inst.context_ids = set()
        inst.utilization = 0.0
    return instances


@pytest.fixture
def mock_wpm_class(mocker: MockerFixture, mock_wpm_instances: list[MagicMock]):
    """
    Patch WorkerPool's WorkerProcessManager symbol so construction yields mocks
    """
    return mocker.patch(
        "src.shared.utils.worker_pool.worker_pool.WorkerProcessManager",
        side_effect=mock_wpm_instances,
    )


@pytest.fixture
def contexts() -> list[ContextAssignment]:
    """
    Default context assignments
        0: Context "context" tag, on all workers
        1: LoggerContext "log_context" tag, on all workers
        2: SlowContext "slow_context" tag, on all workers
    Tests that need different pinning can override.
    """
    return [
        ContextAssignment(
            context_def=Context(CTX_CONTEXT), worker_ids=[0, 1, 2]
        ),
        ContextAssignment(context_def=LoggerContext(), worker_ids=[0, 1, 2]),
        ContextAssignment(context_def=SlowContext(0), worker_ids=[0, 1, 2]),
    ]


def _set_context_ids_from(
    mock_wpm_instances: list[MagicMock], contexts: list[ContextAssignment]
):
    """
    Compute the per-worker context_id sets from the assignment list and apply
    them to the mocks so the pool's routing sees the same state it would in
    production.
    """
    per_worker: list[set[int]] = [set() for _ in mock_wpm_instances]
    for context_id, assignment in enumerate(contexts):
        for worker_id in assignment.worker_ids:
            per_worker[worker_id].add(context_id)
    for worker_id, inst in enumerate(mock_wpm_instances):
        inst.context_ids = per_worker[worker_id]


# pylint: disable=unused-argument
@pytest_asyncio.fixture
async def pool(
    mock_wpm_class: MockType,
    mock_wpm_instances: list[MagicMock],
    contexts: list[ContextAssignment],
    mock_logger: Logger,
):
    """
    Create a fresh WorkerPool with mocked WorkerProcessManagers and handle teardown
    """
    _set_context_ids_from(mock_wpm_instances, contexts)
    pool = WorkerPool(mock_logger, len(mock_wpm_instances), contexts)

    yield pool

    pool.shutdown()


# pylint: disable=unused-argument
def test_worker_pool_correctly_shuts_down_processes(
    mock_logger: MagicMock,
    mock_wpm_class: MockType,
    mock_wpm_instances: list[MagicMock],
    contexts: list[ContextAssignment],
):
    """
    Test that worker pool correctly shuts down processes when pool is shutdown
    """
    # Arrange / Act
    pool = WorkerPool(mock_logger, len(mock_wpm_instances), contexts)
    pool.shutdown()

    # Assert
    for instance in mock_wpm_instances:
        instance.send_terminate.assert_called_once()
        instance.wait_shutdown.assert_called_once()


# pylint: disable=unused-argument
def test_worker_pool_instantiates_processes_with_assigned_contexts(
    mock_logger: MagicMock,
    mock_wpm_class: MockType,
    mock_wpm_instances: list[MagicMock],
    contexts: list[ContextAssignment],
    pool: WorkerPool,
):
    """
    Test that each WorkerProcessManager is instantiated with exactly the
    context_defs assigned to it via worker_ids
    """
    # Arrange / Act
    num_workers = len(mock_wpm_instances)
    expected_per_worker: list[dict[int, Any]] = [{} for _ in range(num_workers)]
    for context_id, assignment in enumerate(contexts):
        for worker_id in assignment.worker_ids:
            expected_per_worker[worker_id][context_id] = assignment.context_def

    # Assert each worker got its expected context_defs as the 3rd positional arg
    assert mock_wpm_class.call_count == num_workers
    for worker_id in range(num_workers):
        args, _ = mock_wpm_class.call_args_list[worker_id]
        assert args[0] is mock_logger
        assert args[1] == worker_id
        assert args[2] == expected_per_worker[worker_id]


def test_worker_pool_raises_on_invalid_worker_id(
    mock_logger: MagicMock,
    # pylint: disable=unused-argument
    mock_wpm_class: MockType,
):
    """
    Test that worker_ids pointing outside [0, num_workers) raise at construction
    """
    # Arrange / Act / Assert
    with pytest.raises(ValueError, match="invalid worker_id"):
        WorkerPool(
            mock_logger,
            2,
            [
                ContextAssignment(
                    context_def=Context(CTX_CONTEXT), worker_ids=[5]
                )
            ],
        )


def test_worker_pool_raises_on_zero_workers(
    mock_logger: MagicMock,
    # pylint: disable=unused-argument
    mock_wpm_class: MockType,
):
    """
    Test that constructing with num_workers <= 0 raises
    """
    # Arrange / Act / Assert
    with pytest.raises(ValueError, match="at least 1"):
        WorkerPool(mock_logger, 0, [])


def test_fetch_single_context_by_tag(pool: WorkerPool):
    """
    Test fetching context_ids for a tag that matches one context
    """
    # Arrange / Act
    context_ids = pool.get_context_ids_by_tag("log_context")

    # Assert
    assert context_ids == {CTX_LOGGER}


def test_fetch_unknown_tag_returns_empty(pool: WorkerPool):
    """
    Test that fetching by an unknown tag returns an empty set
    """
    # Arrange / Act
    context_ids = pool.get_context_ids_by_tag("does_not_exist")

    # Assert
    assert context_ids == set()


def test_register_job_no_context_picks_lowest_utilization(
    pool: WorkerPool, mock_wpm_instances: list[MagicMock]
):
    """
    Test that registering a job with no context tag picks the worker with
    lowest utilization
    """
    # Arrange
    period_ms = 1000
    job = MagicMock(spec=JobInterface)

    mock_wpm_instances[0].utilization = 0.5
    mock_wpm_instances[1].utilization = 0.0
    mock_wpm_instances[2].utilization = 0.25

    # Act
    pool.register_job((), period_ms, job)

    # Assert
    mock_wpm_instances[0].register_job.assert_not_called()
    mock_wpm_instances[1].register_job.assert_called_once_with(
        (), period_ms, job
    )
    mock_wpm_instances[2].register_job.assert_not_called()


def test_register_job_routes_to_worker_owning_required_tag(
    mock_logger: MagicMock,
    # pylint: disable=unused-argument
    mock_wpm_class: MockType,
    mock_wpm_instances: list[MagicMock],
):
    """
    Test that a job requesting a tag is routed only to workers that own a
    matching context - workers without that context are skipped even if they
    have lower utilization
    """
    # Arrange - only worker 2 has the slow_context, context_id 0 in this list
    contexts = [ContextAssignment(context_def=SlowContext(0), worker_ids=[2])]
    _set_context_ids_from(mock_wpm_instances, contexts)
    pool = WorkerPool(mock_logger, len(mock_wpm_instances), contexts)

    mock_wpm_instances[0].utilization = 0.0  # lowest utilization but no context
    mock_wpm_instances[1].utilization = 0.1
    mock_wpm_instances[2].utilization = 0.5

    period_ms = 1000
    job = MagicMock(spec=JobInterface)

    # Act
    pool.register_job(("slow_context",), period_ms, job)

    # Assert
    mock_wpm_instances[0].register_job.assert_not_called()
    mock_wpm_instances[1].register_job.assert_not_called()
    mock_wpm_instances[2].register_job.assert_called_once_with(
        (0,), period_ms, job
    )


def test_register_job_picks_lowest_utilization_among_owning_workers(
    pool: WorkerPool, mock_wpm_instances: list[MagicMock]
):
    """
    Test that when multiple workers own the requested context, the one with
    lowest utilization is picked
    """
    # Arrange
    period_ms = 1000
    job = MagicMock(spec=JobInterface)

    mock_wpm_instances[0].utilization = 0.5
    mock_wpm_instances[1].utilization = 0.1
    mock_wpm_instances[2].utilization = 0.3

    # Act
    pool.register_job(("log_context",), period_ms, job)

    # Assert
    mock_wpm_instances[0].register_job.assert_not_called()
    mock_wpm_instances[1].register_job.assert_called_once_with(
        (CTX_LOGGER,), period_ms, job
    )
    mock_wpm_instances[2].register_job.assert_not_called()


def test_register_job_with_multiple_tags_needs_all_on_same_worker(
    mock_logger: MagicMock,
    # pylint: disable=unused-argument
    mock_wpm_class: MockType,
    mock_wpm_instances: list[MagicMock],
):
    """
    Test that registering a job with multiple tags requires a single worker
    to own a context for every tag - partial coverage doesn't qualify
    """
    # Arrange
    # worker 0 owns CTX_CONTEXT only
    # worker 1 owns CTX_LOGGER only
    # worker 2 owns both - should be picked
    contexts = [
        ContextAssignment(context_def=Context(CTX_CONTEXT), worker_ids=[0, 2]),
        ContextAssignment(context_def=LoggerContext(), worker_ids=[1, 2]),
    ]
    _set_context_ids_from(mock_wpm_instances, contexts)
    pool = WorkerPool(mock_logger, len(mock_wpm_instances), contexts)

    mock_wpm_instances[0].utilization = 0.0
    mock_wpm_instances[1].utilization = 0.0
    mock_wpm_instances[2].utilization = 0.5

    period_ms = 1000
    job = MagicMock(spec=JobInterface)

    # Act
    pool.register_job(("context", "log_context"), period_ms, job)

    # Assert
    mock_wpm_instances[0].register_job.assert_not_called()
    mock_wpm_instances[1].register_job.assert_not_called()
    mock_wpm_instances[2].register_job.assert_called_once_with(
        (CTX_CONTEXT, CTX_LOGGER), period_ms, job
    )


def test_register_job_raises_runtime_error_if_no_worker_owns_all_tags(
    mock_logger: MagicMock,
    # pylint: disable=unused-argument
    mock_wpm_class: MockType,
    mock_wpm_instances: list[MagicMock],
):
    """
    Test that RuntimeError is raised when no single worker owns a context for
    every requested tag, even if the tags individually exist
    """
    # Arrange - disjoint coverage
    contexts = [
        ContextAssignment(context_def=Context(CTX_CONTEXT), worker_ids=[0]),
        ContextAssignment(context_def=LoggerContext(), worker_ids=[1]),
    ]
    _set_context_ids_from(mock_wpm_instances, contexts)
    pool = WorkerPool(mock_logger, len(mock_wpm_instances), contexts)

    period_ms = 1000
    job = MagicMock(spec=JobInterface)

    # Act / Assert
    with pytest.raises(RuntimeError):
        pool.register_job(("context", "log_context"), period_ms, job)


def test_register_job_raises_key_error_for_invalid_tag(pool: WorkerPool):
    """
    Test that a KeyError is raised if the context_tag matches no definitions
    """
    # Arrange
    period_ms = 1000
    job = MagicMock(spec=JobInterface)

    # Act / Assert
    with pytest.raises(
        KeyError,
        match="context tag: non_existent_tag matched 0 context definitions",
    ):
        pool.register_job(("non_existent_tag",), period_ms, job)
