"""
Unit tests for WorkerPool
"""

from typing import Any
from unittest.mock import MagicMock, call

import pytest
import pytest_asyncio
from pytest_mock import MockerFixture, MockType

from src.shared.logger import Logger
from src.shared.utils.worker_pool import (
    JobContextInterface,
    WorkerPool,
    WorkerProcessManager,
)

from .context_definitions import (
    Context,
    ErrorContext,
    LoggerContext,
    SlowContext,
)
from .jobs import SumJob

TEST_CONTEXT_ID_0 = 1
TEST_CONTEXT_ID_1 = 2
TEST_LOGGER_CONTEXT = 3
TEST_ERROR_CONTEXT = 4
TEST_SLOW_CONTEXT = 5

ROLLING_UTILIZATION_WINDOW_SEC = 3


@pytest.fixture
def mock_logger():
    """
    Create a mocked logger instance for tests
    """
    return


@pytest.fixture
def mock_wpm_instances(mocker: MockerFixture):
    """
    Creates set of mock WorkerProcessManager instances for WorkerPool to use
    """
    mock_wpm_instances = [
        mocker.MagicMock(spec=WorkerProcessManager),
        mocker.MagicMock(spec=WorkerProcessManager),
        mocker.MagicMock(spec=WorkerProcessManager),
    ]

    return mock_wpm_instances


@pytest.fixture
def mock_wpm_class(mocker: MockerFixture, mock_wpm_instances: list[MagicMock]):
    """
    Patches WorkerPool's WorkerProcessManager import to use mocked instances
    """
    return mocker.patch(
        "src.shared.utils.worker_pool.worker_pool.WorkerProcessManager",
        side_effect=mock_wpm_instances,
    )


@pytest.fixture
def context_def():
    """
    Defines mapping from context ids to context definition
    """
    return {
        TEST_CONTEXT_ID_0: Context(TEST_CONTEXT_ID_0),
        TEST_CONTEXT_ID_1: Context(TEST_CONTEXT_ID_1),
        TEST_LOGGER_CONTEXT: LoggerContext(),
        TEST_ERROR_CONTEXT: ErrorContext(),
        TEST_SLOW_CONTEXT: SlowContext(0),
    }


# pylint: disable=unused-argument
@pytest_asyncio.fixture
async def pool(
    mock_wpm_class: MockType,
    mock_wpm_instances: list[MagicMock],
    context_def: dict[int, JobContextInterface[Any]],
    mock_logger: Logger,
):
    """
    Create a fresh instance of WorkerPool for each test and handle teardown
    """
    pool = WorkerPool(
        mock_logger,
        len(mock_wpm_instances),
        context_def,
        ROLLING_UTILIZATION_WINDOW_SEC,
    )

    yield pool

    pool.shutdown()


# pylint: disable=unused-argument
def test_worker_pool_correctly_shutdown_processes(
    mock_logger: MagicMock,
    mock_wpm_class: MockType,
    mock_wpm_instances: list[MagicMock],
    context_def: dict[int, JobContextInterface[Any]],
):
    """
    Test that worker pool correctly shuts down processes when pool is shutdown
    """
    # Arrange / Act
    pool = WorkerPool(
        mock_logger,
        len(mock_wpm_instances),
        context_def,
        ROLLING_UTILIZATION_WINDOW_SEC,
    )
    pool.shutdown()

    # Assert
    for instance in mock_wpm_instances:
        instance.send_terminate.assert_called_once()
        instance.wait_shutdown.assert_called_once()


# pylint: disable=unused-argument
def test_worker_pool_correctly_instantiates_processes(
    mock_logger: MagicMock,
    mock_wpm_class: MockType,
    mock_wpm_instances: list[MagicMock],
    context_def: dict[int, JobContextInterface[Any]],
    pool: WorkerPool,
):
    """
    Test that worker pool creates processes with unique ids and correct configuration
    """
    # Arrange / Act
    num_workers = len(mock_wpm_instances)
    expected_calls = [
        call(mock_logger, id, context_def, ROLLING_UTILIZATION_WINDOW_SEC)
        for id in range(num_workers)
    ]

    # Assert
    assert mock_wpm_class.call_count == num_workers
    mock_wpm_class.assert_has_calls(expected_calls)


def test_fetch_single_context_by_tag(pool: WorkerPool):
    """
    Test that fetching a single context by tags returns single matching context id
    """
    # Arrange / Act
    context_ids = pool.get_context_ids_by_tag("error")

    # Assert
    assert context_ids == set([TEST_ERROR_CONTEXT])


def test_fetch_multiple_context_by_tag(pool: WorkerPool):
    """
    Test that fetching a multiple contexts by tags returns all matching context ids
    """
    # Arrange / Act
    context_ids = pool.get_context_ids_by_tag("no_error")

    # Assert
    assert context_ids == set(
        [
            TEST_CONTEXT_ID_0,
            TEST_CONTEXT_ID_1,
            TEST_LOGGER_CONTEXT,
            TEST_SLOW_CONTEXT,
        ]
    )


def test_tagged_context_is_instance_valid_single_definition(pool: WorkerPool):
    """
    Test checking context instances where tagged context definitions are the same
    """
    # Arrange / Act / Assert
    assert pool.tagged_context_is_instance("context", [Context])


def test_tagged_context_is_instance_invalid_single_definition(pool: WorkerPool):
    """
    Test checking context instances where tagged context definitions don't match given definition
    """
    # Arrange / Act / Assert
    assert pool.tagged_context_is_instance("no_error", [ErrorContext]) is False


def test_tagged_context_is_instance_valid_multiple_definitions(
    pool: WorkerPool,
):
    """
    Test checking context instances where tagged context definitions are not the same
    """
    # Arrange / Act / Assert
    assert pool.tagged_context_is_instance(
        "none_context", [LoggerContext, SlowContext]
    )


def test_tagged_context_is_instance_invalid_multiple_definitions(
    pool: WorkerPool,
):
    """
    Test checking context instances where tagged context definitions
    are not the same and don't match given definition
    """
    # Arrange / Act / Assert
    assert (
        pool.tagged_context_is_instance(
            "no_error", [LoggerContext, SlowContext]
        )
        is False
    )


def test_register_job_no_context(
    pool: WorkerPool, mock_wpm_instances: list[MagicMock]
):
    """
    Test that registering a job with no context selects the process with lowest utilization
    """
    # Arrange
    period_ms = 1000
    job = SumJob()

    mock_wpm_instances[0].utilization = 0.5
    mock_wpm_instances[1].utilization = 0
    mock_wpm_instances[2].utilization = 0.25

    # Act
    pool.register_job(None, period_ms, job)

    # Assert
    mock_wpm_instances[0].register_job.assert_not_called()
    mock_wpm_instances[1].register_job.assert_called_once_with(
        None, period_ms, job
    )
    mock_wpm_instances[2].register_job.assert_not_called()


def test_register_job_with_context_single_tag_match_no_active(
    pool: WorkerPool, mock_wpm_instances: list[MagicMock]
):
    """
    Test that registering a job with context tag that matches a single definition
    with no active instance assigns job to lowest utilization process
    """
    # Arrange
    period_ms = 1000
    job = SumJob()

    mock_wpm_instances[0].utilization = 0.1
    mock_wpm_instances[1].utilization = 0.5
    mock_wpm_instances[2].utilization = 0.25

    # Act
    pool.register_job("log_context", period_ms, job)

    # Assert
    mock_wpm_instances[0].register_job.assert_called_once_with(
        TEST_LOGGER_CONTEXT, period_ms, job
    )
    mock_wpm_instances[1].register_job.assert_not_called()
    mock_wpm_instances[2].register_job.assert_not_called()


def test_register_job_prefers_active_context_over_lower_utilization(
    pool: WorkerPool, mock_wpm_instances: list[MagicMock]
):
    """
    Test that the job scheduler prefers a process that already has the
    context active, even if another process has slightly lower utilization,
    due to the ACTIVE_CONTEXT_SCORE_BONUS.
    """
    # Arrange
    period_ms = 1000
    job = SumJob()

    mock_wpm_instances[0].utilization = 0.1
    mock_wpm_instances[0].active_context_ids = set()

    mock_wpm_instances[1].utilization = 0.5
    mock_wpm_instances[1].active_context_ids = set()

    mock_wpm_instances[2].utilization = 0.15
    mock_wpm_instances[2].active_context_ids = {TEST_LOGGER_CONTEXT}

    # Act
    pool.register_job("log_context", period_ms, job)

    # Assert
    mock_wpm_instances[0].register_job.assert_not_called()
    mock_wpm_instances[1].register_job.assert_not_called()
    mock_wpm_instances[2].register_job.assert_called_once_with(
        TEST_LOGGER_CONTEXT, period_ms, job
    )


def test_register_job_prefers_create_context_over_high_utilization_active_context(
    pool: WorkerPool, mock_wpm_instances: list[MagicMock]
):
    """
    Test that the job scheduler prefers a process that doesn't have
    active context over one with active context when utilization
    on active context exceeds ACTIVE_CONTEXT_SCORE_BONUS
    """
    # Arrange
    period_ms = 1000
    job = SumJob()

    mock_wpm_instances[0].utilization = 0.2
    mock_wpm_instances[0].active_context_ids = set()

    mock_wpm_instances[1].utilization = 0.1
    mock_wpm_instances[1].active_context_ids = set()

    mock_wpm_instances[2].utilization = 0.5
    mock_wpm_instances[2].active_context_ids = {TEST_LOGGER_CONTEXT}

    # Act
    pool.register_job("log_context", period_ms, job)

    # Assert
    mock_wpm_instances[0].register_job.assert_not_called()
    mock_wpm_instances[1].register_job.assert_called_once_with(
        TEST_LOGGER_CONTEXT, period_ms, job
    )
    mock_wpm_instances[2].register_job.assert_not_called()


def test_register_job_respects_max_instances(
    pool: WorkerPool, mock_wpm_instances: list[MagicMock]
):
    """
    Test that if a context's max_instances is reached, a new job for
    that context can only be assigned to a process already running it.
    """
    # Arrange
    period_ms = 1000
    job = SumJob()

    mock_wpm_instances[0].utilization = 0.3
    mock_wpm_instances[0].active_context_ids = {TEST_SLOW_CONTEXT}

    mock_wpm_instances[1].utilization = 0.5
    mock_wpm_instances[1].active_context_ids = {TEST_SLOW_CONTEXT}

    mock_wpm_instances[2].utilization = 0.1
    mock_wpm_instances[2].active_context_ids = set()

    # Act
    pool.register_job("slow_context", period_ms, job)

    # Assert
    mock_wpm_instances[0].register_job.assert_called_once_with(
        TEST_SLOW_CONTEXT, period_ms, job
    )
    mock_wpm_instances[1].register_job.assert_not_called()
    mock_wpm_instances[2].register_job.assert_not_called()


def test_register_job_avoids_context_own_negative_affinity(
    pool: WorkerPool, mock_wpm_instances: list[MagicMock]
):
    """
    Test that a job is not assigned to a process if its context has
    negative affinity with a context already active on that process.
    """
    # Arrange
    period_ms = 1000
    job = SumJob()

    mock_wpm_instances[0].utilization = 0.1
    mock_wpm_instances[0].active_context_ids = {TEST_LOGGER_CONTEXT}

    mock_wpm_instances[1].utilization = 0.2
    mock_wpm_instances[1].active_context_ids = set()

    mock_wpm_instances[2].utilization = 0.3
    mock_wpm_instances[2].active_context_ids = set()

    # Act
    pool.register_job("slow_context", period_ms, job)

    # Assert
    mock_wpm_instances[0].register_job.assert_not_called()
    mock_wpm_instances[1].register_job.assert_called_once_with(
        TEST_SLOW_CONTEXT, period_ms, job
    )
    mock_wpm_instances[2].register_job.assert_not_called()


def test_register_job_avoids_active_context_negative_affinity(
    pool: WorkerPool, mock_wpm_instances: list[MagicMock]
):
    """
    Test that a job is not assigned to a process if a process has active context
    that has negative affinity with requested context
    """
    # Arrange
    period_ms = 1000
    job = SumJob()

    mock_wpm_instances[0].utilization = 0.2
    mock_wpm_instances[0].active_context_ids = set()

    mock_wpm_instances[1].utilization = 0.5
    mock_wpm_instances[1].active_context_ids = set()

    mock_wpm_instances[2].utilization = 0.1
    mock_wpm_instances[2].active_context_ids = {TEST_SLOW_CONTEXT}

    # Act
    pool.register_job("log_context", period_ms, job)

    # Assert
    mock_wpm_instances[0].register_job.assert_called_once_with(
        TEST_LOGGER_CONTEXT, period_ms, job
    )
    mock_wpm_instances[1].register_job.assert_not_called()
    mock_wpm_instances[2].register_job.assert_not_called()


def test_register_job_raises_runtime_error_if_no_valid_assignment(
    pool: WorkerPool, mock_wpm_instances: list[MagicMock]
):
    """
    Test that a RuntimeError is raised if all processes are disqualified
    (e.g., by negative affinity or max_instances).
    """
    # Arrange
    period_ms = 1000
    job = SumJob()

    mock_wpm_instances[0].utilization = 0.1
    mock_wpm_instances[0].active_context_ids = {TEST_LOGGER_CONTEXT}

    mock_wpm_instances[1].utilization = 0.1
    mock_wpm_instances[1].active_context_ids = {TEST_LOGGER_CONTEXT}

    mock_wpm_instances[2].utilization = 0.1
    mock_wpm_instances[2].active_context_ids = {TEST_LOGGER_CONTEXT}

    # Act / Assert
    with pytest.raises(RuntimeError):
        pool.register_job("slow_context", period_ms, job)


def test_register_job_raises_key_error_for_invalid_tag(pool: WorkerPool):
    """
    Test that a KeyError is raised if the context_tag matches no definitions.
    """
    # Arrange
    period_ms = 1000
    job = SumJob()

    # Act / Assert
    with pytest.raises(
        KeyError,
        match="context tag: non_existent_tag matched 0 context definitions",
    ):
        pool.register_job("non_existent_tag", period_ms, job)
