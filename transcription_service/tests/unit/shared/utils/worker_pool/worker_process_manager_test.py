"""
Unit tests for WorkerProcessManager
"""

import asyncio
from typing import Any
from unittest.mock import MagicMock

import pytest

from src.shared.logger import ContextLogger
from src.shared.utils.worker_pool import (
    JobContextInterface,
    JobException,
    JobSuccess,
    WorkerProcessManager,
)

from .conftest import TEST_ROLLING_UTILIZATION_WINDOW_NS, TEST_WORKER_ID
from .context_definitions import (
    Context,
    ContextInstance,
    CrashContext,
    ErrorContext,
    LoggerContext,
)
from .jobs import ContextJob, ErrorJob, LoggerJob, SlowJob, SumJob

# These tests spawn real worker processes; process spawn alone can take ~1-2s
# on a loaded CI runner, and pytest-timeout's budget includes fixture setup.
# Give them generous headroom so spawn latency does not flake them (whole-suite
# hangs are still caught by the job-level timeout and the init-hang regression
# test below).
pytestmark = pytest.mark.timeout(5)

NS_PER_SEC = 10**9

TEST_CONTEXT_ID_0 = 0
TEST_CONTEXT_ID_1 = 1
TEST_LOGGER_CONTEXT = 2


def assert_logger_was_called_with(
    mock_underlying_logger: MagicMock, msg: str, context: dict[str, Any]
):
    """
    Asserts that a logging.logger mock instance handled a LogRecord with given message and context

    Args:
        mock_underlying_logger  - Mock logging.logger instance to check
        msg                     - Message that logger was exected to have handled
        context                 - Context that logger was exected to have handled
    """
    logged = False
    for call in mock_underlying_logger.handle.call_args_list:
        if "context" not in call[0][0].__dict__:
            continue

        msg_context = call[0][0].__dict__["context"]
        message = call[0][0].getMessage()

        if msg_context == context and message == msg:
            logged = True
    assert logged


def assert_rel_error(measured: int, expected: int, rtol: float = 1e-3):
    """
    Asserts that relative error is below tolerance

    Args:
        rtol    - Relative error tolerance
    """
    assert abs(measured - expected) / expected < rtol


def assert_instant_time(measured_ns: int):
    """
    Asserts that timestamp in nanoseconds is basically 0
    """
    assert 0 < measured_ns < 1e-3 * NS_PER_SEC


@pytest.fixture
def context_defs() -> dict[int, JobContextInterface[Any]]:
    """
    Pre-initialized contexts the WorkerProcessManager fixture starts with.
    ErrorContext is intentionally excluded - including it would fail worker init.
    """
    return {
        TEST_CONTEXT_ID_0: Context(TEST_CONTEXT_ID_0),
        TEST_CONTEXT_ID_1: Context(TEST_CONTEXT_ID_1),
        TEST_LOGGER_CONTEXT: LoggerContext(),
    }


@pytest.mark.asyncio
async def test_job_handle_has_correct_worker_id(wpm: WorkerProcessManager):
    """
    Test that a job handle has worker id property
    """
    # Arrange / Act
    job = wpm.register_job((), 200, SumJob())

    # Assert
    assert job.worker_id == TEST_WORKER_ID


@pytest.mark.asyncio
async def test_job_handle_has_unique_job_id(wpm: WorkerProcessManager):
    """
    Test that a job handle has unique job id property
    """
    # Arrange / Act
    job0 = wpm.register_job((), 200, SumJob())
    job1 = wpm.register_job((), 200, SumJob())

    # Assert
    assert job0.job_id != job1.job_id


@pytest.mark.asyncio
async def test_single_job_executes_once(wpm: WorkerProcessManager):
    """
    Test that a single job executes on queued data and returns results
    """
    # Arrange
    results: list[JobSuccess[int] | JobException] = []

    job = wpm.register_job((), 200, SumJob())
    job.on(job.JobResultEvent, results.append)

    # Act
    job.queue_data([1, 2, 3])
    await asyncio.sleep(0.2 + 0.1)

    # Assert
    assert len(results) == 1
    assert results[0].has_exception is False
    assert results[0].value == 6


@pytest.mark.asyncio
async def test_single_job_executes_multiple_times(wpm: WorkerProcessManager):
    """
    Test that a single job executes on queued data and returns
    results multiple times based on configured period
    """
    # Arrange
    results: list[JobSuccess[int] | JobException] = []

    job = wpm.register_job((), 200, SumJob())
    job.on(job.JobResultEvent, results.append)

    # Act
    job.queue_data([1, 2, 3])
    await asyncio.sleep(0.2 + 0.1)

    job.queue_data([4, 5, 6])
    await asyncio.sleep(0.2)

    job.queue_data([7, 8, 9])
    job.queue_data([10])
    await asyncio.sleep(0.2)

    # Assert
    assert len(results) == 3
    assert results[0].value == 6
    assert results[1].value == 15
    assert results[2].value == 34


@pytest.mark.asyncio
async def test_multiple_jobs_same_period_execute_multiple_timess(
    wpm: WorkerProcessManager,
):
    """
    Test that multiple jobs with the same period executes on
    queued data and returns results independently
    """
    # Arrange
    results0: list[JobSuccess[int] | JobException] = []
    results1: list[JobSuccess[int] | JobException] = []

    job0 = wpm.register_job((), 200, SumJob())
    job1 = wpm.register_job((), 200, SumJob())
    job0.on(job0.JobResultEvent, results0.append)
    job1.on(job1.JobResultEvent, results1.append)

    # Act
    job0.queue_data([1])
    job1.queue_data([2])
    await asyncio.sleep(0.2 + 0.1)

    job0.queue_data([3])
    job1.queue_data([4])
    await asyncio.sleep(0.2)

    # Assert
    assert len(results0) == 2
    assert results0[0].value == 1
    assert results0[1].value == 3
    assert len(results1) == 2
    assert results1[0].value == 2
    assert results1[1].value == 4


@pytest.mark.asyncio
async def test_multiple_jobs_different_period_execute_multiple_timess(
    wpm: WorkerProcessManager,
):
    """
    Test that multiple jobs with different periods executes
    on queued data and returns results independently
    """
    # Arrange
    results0: list[JobSuccess[int] | JobException] = []
    results1: list[JobSuccess[int] | JobException] = []

    job0 = wpm.register_job((), 200, SumJob())
    job1 = wpm.register_job((), 400, SumJob())
    job0.on(job0.JobResultEvent, results0.append)
    job1.on(job1.JobResultEvent, results1.append)

    # Act
    job0.queue_data([1])
    job1.queue_data([2])
    await asyncio.sleep(0.2 + 0.1)

    job0.queue_data([3])
    job1.queue_data([4])
    await asyncio.sleep(0.2)

    job0.queue_data([5])
    job1.queue_data([6])
    await asyncio.sleep(0.2)

    job0.queue_data([7])
    await asyncio.sleep(0.2)

    # Assert
    assert len(results0) == 4
    assert results0[0].value == 1
    assert results0[1].value == 3
    assert results0[2].value == 5
    assert results0[3].value == 7
    assert len(results1) == 2
    assert results1[0].value == 6
    assert results1[1].value == 6


@pytest.mark.asyncio
async def test_single_error_job_returns_error(wpm: WorkerProcessManager):
    """
    Test that job that raises exception returns error result
    """
    # Arrange
    results: list[JobSuccess[None] | JobException] = []

    job = wpm.register_job((), 200, ErrorJob())
    job.on(job.JobResultEvent, results.append)

    # Act
    await asyncio.sleep(0.2 + 0.1)

    # Assert
    assert len(results) == 1
    assert results[0].has_exception
    assert isinstance(results[0].value, RuntimeError)


@pytest.mark.asyncio
async def test_error_job_is_not_rescheduled(wpm: WorkerProcessManager):
    """
    Test that job that raises exception is not rescheduled
    """
    # Arrange
    results: list[JobSuccess[None] | JobException] = []

    job = wpm.register_job((), 1, ErrorJob())
    job.on(job.JobResultEvent, results.append)

    # Act
    await asyncio.sleep(0.1)

    # Assert
    assert len(results) == 1


@pytest.mark.asyncio
async def test_multiple_error_jobs_returns_errors(wpm: WorkerProcessManager):
    """
    Test that running multiple jobs that raise exceptions returns multiple error results
    """
    # Arrange
    results: list[JobSuccess[None] | JobException] = []

    for _ in range(10):
        job = wpm.register_job((), 200, ErrorJob())
        job.on(job.JobResultEvent, results.append)

    # Act
    await asyncio.sleep(0.5 + 0.1)

    # Assert
    assert len(results) == 10
    for i in range(10):
        assert results[i].has_exception
        assert isinstance(results[i].value, RuntimeError)


@pytest.mark.asyncio
async def test_deregister_single_job_single_registered(
    wpm: WorkerProcessManager,
):
    """
    Test that deregistering a job stops it from being executed
    """
    # Arrange
    results: list[JobSuccess[int] | JobException] = []

    job = wpm.register_job((), 200, SumJob())
    job.on(job.JobResultEvent, results.append)

    # Act
    await asyncio.sleep(0.2 + 0.1)
    job.deregister()
    await asyncio.sleep(0.4)

    # Assert
    assert len(results) == 1


@pytest.mark.asyncio
async def test_deregister_single_job_multiple_registered(
    wpm: WorkerProcessManager,
):
    """
    Test that deregistering a job doesn't affect other registered jobs
    """
    # Arrange
    results0: list[JobSuccess[int] | JobException] = []
    results1: list[JobSuccess[int] | JobException] = []

    job0 = wpm.register_job((), 200, SumJob())
    job1 = wpm.register_job((), 200, SumJob())
    job0.on(job0.JobResultEvent, results0.append)
    job1.on(job1.JobResultEvent, results1.append)

    # Act
    await asyncio.sleep(0.2 + 0.1)
    job0.deregister()
    await asyncio.sleep(0.4)

    # Assert
    assert len(results0) == 1
    assert len(results1) == 3


@pytest.mark.asyncio
async def test_deregister_single_job_while_running_multiple_registered(
    wpm: WorkerProcessManager,
):
    """
    Test that deregistering an actively executing job doesn't affect other registered jobs
    """
    # Arrange
    results0: list[JobSuccess[None] | JobException] = []
    results1: list[JobSuccess[int] | JobException] = []

    job0 = wpm.register_job((), 200, SlowJob(int(0.2 * NS_PER_SEC)))
    job1 = wpm.register_job((), 400, SumJob())
    job0.on(job0.JobResultEvent, results0.append)
    job1.on(job1.JobResultEvent, results1.append)

    # Act
    await asyncio.sleep(0.2 + 0.1)
    job0.deregister()
    await asyncio.sleep(0.4)

    # Assert
    assert len(results0) == 0
    assert len(results1) == 1


@pytest.mark.asyncio
async def test_reuses_pre_initialized_context_instance(
    wpm: WorkerProcessManager,
):
    """
    Test that all jobs using the same context_id receive the single context
    instance created at worker startup (no per-job creation)
    """
    # Arrange
    results0: list[JobSuccess[ContextInstance] | JobException] = []
    results1: list[JobSuccess[ContextInstance] | JobException] = []

    job0 = wpm.register_job((TEST_CONTEXT_ID_0,), 200, ContextJob())
    job1 = wpm.register_job((TEST_CONTEXT_ID_0,), 200, ContextJob())
    job0.on(job0.JobResultEvent, results0.append)
    job1.on(job1.JobResultEvent, results1.append)

    # Act
    await asyncio.sleep(0.2 + 0.1)

    # Assert
    assert len(results0) == 1
    assert results0[0].value == ContextInstance(
        TEST_CONTEXT_ID_0, create_count=1, destroy_count=0
    )
    assert len(results1) == 1
    assert results1[0].value == ContextInstance(
        TEST_CONTEXT_ID_0, create_count=1, destroy_count=0
    )


@pytest.mark.asyncio
async def test_distinct_context_ids_yield_distinct_instances(
    wpm: WorkerProcessManager,
):
    """
    Test that jobs requesting different context_ids each receive their own
    pre-initialized instance
    """
    # Arrange
    results0: list[JobSuccess[ContextInstance] | JobException] = []
    results1: list[JobSuccess[ContextInstance] | JobException] = []

    job0 = wpm.register_job((TEST_CONTEXT_ID_0,), 200, ContextJob())
    job1 = wpm.register_job((TEST_CONTEXT_ID_1,), 200, ContextJob())
    job0.on(job0.JobResultEvent, results0.append)
    job1.on(job1.JobResultEvent, results1.append)

    # Act
    await asyncio.sleep(0.2 + 0.1)

    # Assert
    assert len(results0) == 1
    assert results0[0].value == ContextInstance(
        TEST_CONTEXT_ID_0, create_count=1, destroy_count=0
    )
    assert len(results1) == 1
    assert results1[0].value == ContextInstance(
        TEST_CONTEXT_ID_1, create_count=1, destroy_count=0
    )


@pytest.mark.asyncio
async def test_reports_pinned_context_ids(wpm: WorkerProcessManager):
    """
    Test that the manager reports the set of context_ids it has initialized
    """
    # Arrange / Act / Assert
    assert wpm.context_ids == {
        TEST_CONTEXT_ID_0,
        TEST_CONTEXT_ID_1,
        TEST_LOGGER_CONTEXT,
    }


@pytest.mark.asyncio
async def test_worker_init_raises_when_context_creation_fails(
    mock_underlying_logger: MagicMock,
):
    """
    Test that constructing WorkerProcessManager raises if any assigned context
    fails to create on the worker. The pool should not silently advance into
    job acceptance when a context is broken.
    """
    # Arrange
    failing_defs: dict[int, JobContextInterface[Any]] = {0: ErrorContext()}

    # Act / Assert
    with pytest.raises(RuntimeError, match="failed to initialize"):
        WorkerProcessManager(
            ContextLogger(mock_underlying_logger),
            TEST_WORKER_ID,
            failing_defs,
            rolling_utilization_window_ns=TEST_ROLLING_UTILIZATION_WINDOW_NS,
        )


@pytest.mark.asyncio
async def test_worker_init_raises_when_worker_dies_without_reporting(
    mock_underlying_logger: MagicMock,
):
    """
    Test that constructing WorkerProcessManager raises (rather than blocking the
    constructor forever) if the worker process dies during initialization
    without reporting an init error - e.g. a native crash. The parent holds the
    result queue's write fd, so a naive blocking read would never see EOF; the
    module-level timeout guards against a regression to that hang.
    """
    # Arrange
    crashing_defs: dict[int, JobContextInterface[Any]] = {0: CrashContext()}

    # Act / Assert
    with pytest.raises(RuntimeError, match="exited during initialization"):
        WorkerProcessManager(
            ContextLogger(mock_underlying_logger),
            TEST_WORKER_ID,
            crashing_defs,
            rolling_utilization_window_ns=TEST_ROLLING_UTILIZATION_WINDOW_NS,
        )


# Logging
@pytest.mark.asyncio
async def test_job_logger_logs_messages(
    mock_underlying_logger: MagicMock, wpm: WorkerProcessManager
):
    """
    Test that logger provided to job correctly logs messages
    """
    # Arrange
    job = wpm.register_job((), 200, LoggerJob())

    # Act
    await asyncio.sleep(0.2 + 0.1)

    # Assert
    assert_logger_was_called_with(
        mock_underlying_logger,
        "Process Batch",
        {"job_id": job.job_id, "worker_id": TEST_WORKER_ID},
    )


@pytest.mark.asyncio
async def test_context_create_logger_logs_messages(
    mock_underlying_logger: MagicMock,
    # pylint: disable=unused-argument
    wpm: WorkerProcessManager,
):
    """
    Test that logger provided to context create is invoked at worker startup
    (the wpm fixture already constructed the worker, which created the context)
    """
    # Arrange / Act
    await asyncio.sleep(0.05)

    # Assert
    assert_logger_was_called_with(
        mock_underlying_logger,
        "Create Context",
        {"context_id": TEST_LOGGER_CONTEXT, "worker_id": TEST_WORKER_ID},
    )


@pytest.mark.asyncio
async def test_context_destroy_logger_logs_messages(
    mock_underlying_logger: MagicMock,
    context_defs: dict[int, JobContextInterface[Any]],
):
    """
    Test that logger provided to context destroy is invoked at worker shutdown.
    Build and tear down a manager manually so we can assert the destroy log
    after shutdown completes (wait_shutdown drains any pending log records).
    """
    # Arrange - async context required because WorkerProcessManager spins up
    # an asyncio task internally
    # pylint: disable=duplicate-code
    wpm = WorkerProcessManager(
        ContextLogger(mock_underlying_logger),
        TEST_WORKER_ID,
        context_defs,
        rolling_utilization_window_ns=TEST_ROLLING_UTILIZATION_WINDOW_NS,
    )

    # Act
    wpm.send_terminate()
    wpm.wait_shutdown()

    # Assert
    assert_logger_was_called_with(
        mock_underlying_logger,
        "Destroy Context",
        {"context_id": TEST_LOGGER_CONTEXT, "worker_id": TEST_WORKER_ID},
    )


@pytest.mark.asyncio
async def test_reports_jobs_stats_single_slow_job(wpm: WorkerProcessManager):
    """
    Test statistics are correctly reported for single slow job
    """
    # Arrange
    slow_worker_time = NS_PER_SEC

    results: list[JobSuccess[None] | JobException] = []
    job = wpm.register_job((), 200, SlowJob(NS_PER_SEC))
    job.on(job.JobResultEvent, results.append)

    # Act
    await asyncio.sleep(1 + 0.2 + 0.1)

    # Assert
    job_stats = results[0].stats

    assert_instant_time(job_stats.scheduling_delay_ns)
    assert_instant_time(job_stats.context_initialization_time_ns)
    assert_rel_error(job_stats.execution_time_ns, slow_worker_time)
    assert_rel_error(job_stats.total_time_ns, slow_worker_time)


@pytest.mark.timeout(6)
@pytest.mark.asyncio
async def test_reports_job_stats_multiple_slow_job(wpm: WorkerProcessManager):
    """
    Test statistics are correctly reported for multiple slow jobs with scheduling delay
    """
    # Arrange
    slow_worker_time = NS_PER_SEC

    results1: list[JobSuccess[None] | JobException] = []
    wpm.register_job((), 200, SlowJob(NS_PER_SEC))
    job1 = wpm.register_job((), 200, SlowJob(NS_PER_SEC))
    job1.on(job1.JobResultEvent, results1.append)

    # Act
    await asyncio.sleep(2 + 0.2 + 0.1)

    # Assert
    job_stats = results1[0].stats
    assert_rel_error(job_stats.scheduling_delay_ns, slow_worker_time)
    assert_instant_time(job_stats.context_initialization_time_ns)
    assert_rel_error(job_stats.execution_time_ns, slow_worker_time)
    assert_rel_error(
        job_stats.total_time_ns, slow_worker_time + slow_worker_time
    )


@pytest.mark.asyncio
async def test_earliest_deadline_first_scheduling(wpm: WorkerProcessManager):
    """
    Test that job with earliest deadline is scheduled before other jobs
    """
    # Arrange
    results0: list[JobSuccess[int] | JobException] = []
    results1: list[JobSuccess[int] | JobException] = []
    job0 = wpm.register_job((), 100, SumJob())
    job1 = wpm.register_job((), 200, SumJob())
    job0.on(job0.JobResultEvent, results0.append)
    job1.on(job1.JobResultEvent, results1.append)

    # Act
    await asyncio.sleep(0.2 + 0.1)

    # Assert
    # Use second run of job0 because that is when both are ready
    job0_start_time = results0[1].stats.start_execute_time_ns
    job1_start_time = results1[0].stats.start_execute_time_ns

    assert job0_start_time < job1_start_time


@pytest.mark.timeout(10)
@pytest.mark.asyncio
async def test_utilization_report_single_job(wpm: WorkerProcessManager):
    """
    Test that manager correctly reports utilization with single job active
    """
    # Arrange
    target_utilization = 0.25
    window_sec = TEST_ROLLING_UTILIZATION_WINDOW_NS / NS_PER_SEC
    wpm.register_job(
        (),
        int(window_sec * 1000),
        SlowJob(int(target_utilization * window_sec * NS_PER_SEC)),
    )

    # Act
    await asyncio.sleep(window_sec * 2)

    # Assert
    assert abs(wpm.utilization - target_utilization) < 0.1


@pytest.mark.timeout(10)
@pytest.mark.asyncio
async def test_utilization_report_multiple_jobs(wpm: WorkerProcessManager):
    """
    Test that manager correctly reports utilization with multiple jobs active
    """
    # Arrange
    target_utilization = 0.25
    num_jobs = 2
    window_sec = TEST_ROLLING_UTILIZATION_WINDOW_NS / NS_PER_SEC
    for _ in range(num_jobs):
        wpm.register_job(
            (),
            int(window_sec * 1000),
            SlowJob(
                int(target_utilization * window_sec * NS_PER_SEC / num_jobs)
            ),
        )

    # Act
    await asyncio.sleep(window_sec * 2)

    # Assert
    assert abs(wpm.utilization - target_utilization) < 0.1
