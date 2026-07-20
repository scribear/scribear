"""
Unit tests for the WorkerProcessManager job observer and load accessors
"""

import asyncio
import logging

import pytest
import pytest_asyncio

from src.shared.logger import ContextLogger
from src.shared.utils.worker_pool import (
    JobExecutionObservation,
    WorkerProcessManager,
)

from .conftest import TEST_ROLLING_UTILIZATION_WINDOW_NS, TEST_WORKER_ID
from .jobs import CountingJob, ErrorJob, SumJob

# Spawning a real worker process is slower than the global 1s timeout allows
pytestmark = pytest.mark.timeout(2)

JOB_PERIOD_MS = 200
# One period plus slack for the spawn/queue round trip
SETTLE_SEC = 0.3


@pytest_asyncio.fixture
async def observed_wpm(mock_underlying_logger: logging.Logger):
    """
    Creates a WorkerProcessManager wired to a recording observer

    Yields (manager, recorded observations) so tests can drive jobs and read
    what the observer saw.
    """
    recorded: list[JobExecutionObservation] = []

    wpm = WorkerProcessManager(
        ContextLogger(mock_underlying_logger),
        TEST_WORKER_ID,
        {},
        rolling_utilization_window_ns=TEST_ROLLING_UTILIZATION_WINDOW_NS,
        job_observer=recorded.append,
    )

    yield wpm, recorded

    wpm.send_terminate()
    wpm.wait_shutdown()


@pytest.mark.asyncio
async def test_successful_execution_is_observed_with_its_label(
    observed_wpm: tuple[WorkerProcessManager, list[JobExecutionObservation]],
):
    """
    Test a completed job reaches the observer carrying the label it was
    registered with
    """
    # Arrange
    wpm, observations = observed_wpm
    job = wpm.register_job((), JOB_PERIOD_MS, SumJob(), "whisper")

    # Act
    job.queue_data([1, 2, 3])
    await asyncio.sleep(SETTLE_SEC)

    # Assert
    assert len(observations) == 1
    assert observations[0].label == "whisper"
    assert observations[0].worker_id == TEST_WORKER_ID
    assert observations[0].job_id == job.job_id
    assert observations[0].exception is None
    assert observations[0].stats.execution_time_ns > 0


@pytest.mark.asyncio
async def test_failed_execution_is_observed_with_its_exception(
    observed_wpm: tuple[WorkerProcessManager, list[JobExecutionObservation]],
):
    """
    Test a job that raised is reported with the exception, so a consumer can
    label the failure by class
    """
    # Arrange
    wpm, observations = observed_wpm
    job = wpm.register_job((), JOB_PERIOD_MS, ErrorJob(), "whisper")

    # Act
    job.queue_data([1])
    await asyncio.sleep(SETTLE_SEC)

    # Assert
    assert len(observations) == 1
    assert isinstance(observations[0].exception, Exception)


@pytest.mark.asyncio
async def test_observer_failure_does_not_break_result_dispatch(
    mock_underlying_logger: logging.Logger,
):
    """
    Test a raising observer cannot stop a job result reaching its handle

    Metrics are out-of-band bookkeeping; a fault there must not stall a live
    transcription session.
    """

    # Arrange
    def explode(_: JobExecutionObservation):
        raise RuntimeError("observer is broken")

    wpm = WorkerProcessManager(
        ContextLogger(mock_underlying_logger),
        TEST_WORKER_ID,
        {},
        rolling_utilization_window_ns=TEST_ROLLING_UTILIZATION_WINDOW_NS,
        job_observer=explode,
    )
    try:
        results: list[object] = []
        job = wpm.register_job((), JOB_PERIOD_MS, SumJob())
        job.on(job.JobResultEvent, results.append)

        # Act
        job.queue_data([1, 2, 3])
        await asyncio.sleep(SETTLE_SEC)

        # Assert
        assert len(results) == 1
    finally:
        wpm.send_terminate()
        wpm.wait_shutdown()


@pytest.mark.asyncio
async def test_snapshot_tracks_live_and_total_jobs(
    observed_wpm: tuple[WorkerProcessManager, list[JobExecutionObservation]],
):
    """
    Test the public snapshot reports registration counts without reaching
    through private attributes

    Live count falls on deregistration; the total does not, because consumers
    difference it to get a registration rate.
    """
    # Arrange
    wpm, _ = observed_wpm

    # Act / Assert
    assert wpm.snapshot().live_job_count == 0

    first = wpm.register_job((), JOB_PERIOD_MS, SumJob())
    wpm.register_job((), JOB_PERIOD_MS, SumJob())
    snapshot = wpm.snapshot()
    assert snapshot.worker_id == TEST_WORKER_ID
    assert snapshot.live_job_count == 2
    assert snapshot.total_jobs_registered == 2
    assert snapshot.context_ids == set()
    assert 0 <= snapshot.utilization <= 1

    first.deregister()
    snapshot = wpm.snapshot()
    assert snapshot.live_job_count == 1
    assert snapshot.total_jobs_registered == 2


@pytest.mark.asyncio
async def test_counters_cross_the_process_boundary(
    observed_wpm: tuple[WorkerProcessManager, list[JobExecutionObservation]],
):
    """
    Test a counter incremented inside the worker is visible in the parent

    This is the gate the whole cross-process design rests on. Without it the
    worker-side counters would silently report zero forever, and the only
    alternative - parsing the worker's own log records in our own process -
    is exactly the log-string inference this work exists to remove.
    """
    # Arrange
    wpm, observations = observed_wpm
    job = wpm.register_job((), JOB_PERIOD_MS, CountingJob(), "whisper")

    # Act
    job.queue_data([1, 2, 3])
    await asyncio.sleep(SETTLE_SEC)

    # Assert
    assert len(observations) == 1
    assert observations[0].counters == {"items": 3}


@pytest.mark.asyncio
async def test_counters_survive_a_failing_execution(
    observed_wpm: tuple[WorkerProcessManager, list[JobExecutionObservation]],
):
    """
    Test counters accumulated before a raise still reach the parent

    Audio-too-fast is counted and then immediately raised, so a drain that
    only ran on the success path would never report it.
    """
    # Arrange
    wpm, observations = observed_wpm
    job = wpm.register_job((), JOB_PERIOD_MS, CountingJob(fail=True), "whisper")

    # Act
    job.queue_data([1, 2])
    await asyncio.sleep(SETTLE_SEC)

    # Assert
    assert len(observations) == 1
    assert observations[0].exception is not None
    assert observations[0].counters == {"items": 2}


@pytest.mark.asyncio
async def test_jobs_reporting_no_counters_are_unaffected(
    observed_wpm: tuple[WorkerProcessManager, list[JobExecutionObservation]],
):
    """
    Test the default is empty, so jobs opt in rather than being forced to care
    """
    # Arrange
    wpm, observations = observed_wpm
    job = wpm.register_job((), JOB_PERIOD_MS, SumJob())

    # Act
    job.queue_data([1])
    await asyncio.sleep(SETTLE_SEC)

    # Assert
    assert observations[0].counters == {}
