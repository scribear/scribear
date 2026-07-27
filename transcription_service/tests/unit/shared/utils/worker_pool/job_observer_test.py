"""
Unit tests for the WorkerProcessManager job observer and load accessors
"""

import asyncio
import logging

import pytest
import pytest_asyncio

from src.shared.logger import ContextLogger
from src.shared.utils.worker_pool import (
    DROPPED_PERIODS_COUNTER,
    ActiveJob,
    JobExecutionObservation,
    WorkerProcessManager,
)

from .conftest import TEST_ROLLING_UTILIZATION_WINDOW_NS, TEST_WORKER_ID
from .jobs import CountingJob, ErrorJob, SlowJob, SumJob

# Spawning a real worker process is slower than the global 1s timeout allows
pytestmark = pytest.mark.timeout(3)

JOB_PERIOD_MS = 200
# One period plus slack for the spawn/queue round trip
SETTLE_SEC = 0.3

NS_PER_MS = 10**6

# A short period with a pass that cannot fit in it, which is the whole failure
# mode: the pool neither queues nor errors, it advances period_start_ns past the
# periods it missed. 250ms against 100ms drops two periods per pass on an
# unloaded host and at least one on any host, which is what the assertions use -
# the exact count scales with however long the overrun really took.
OVERRUN_PERIOD_MS = 100
OVERRUN_WORK_NS = 250 * NS_PER_MS
# Long enough for three passes at 250ms each, plus spawn slack
OVERRUN_SETTLE_SEC = 0.9


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
    assert len(snapshot.active_jobs) == 2

    first.deregister()
    snapshot = wpm.snapshot()
    assert snapshot.live_job_count == 1
    assert snapshot.total_jobs_registered == 2
    assert len(snapshot.active_jobs) == 1


@pytest.mark.asyncio
async def test_snapshot_correlates_active_jobs_to_session_and_room_uid(
    observed_wpm: tuple[WorkerProcessManager, list[JobExecutionObservation]],
):
    """
    Test active_jobs carries the session_uid/room_uid a job was registered
    with, defaults to None when omitted, and drops the entry on
    deregistration - the same lifetime rule _job_labels already follows
    """
    # Arrange
    wpm, _ = observed_wpm

    # Act
    with_uids = wpm.register_job(
        (), JOB_PERIOD_MS, SumJob(), session_uid="session-1", room_uid="room-1"
    )
    without_uids = wpm.register_job((), JOB_PERIOD_MS, SumJob())

    # Assert - both present, correlated to their own job id
    snapshot = wpm.snapshot()
    assert set(snapshot.active_jobs) == {
        ActiveJob(
            job_id=with_uids.job_id, session_uid="session-1", room_uid="room-1"
        ),
        ActiveJob(job_id=without_uids.job_id, session_uid=None, room_uid=None),
    }

    # Assert - deregistering one leaves only the other
    with_uids.deregister()
    snapshot = wpm.snapshot()
    assert snapshot.active_jobs == (
        ActiveJob(job_id=without_uids.job_id, session_uid=None, room_uid=None),
    )


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


@pytest.mark.asyncio
async def test_overrunning_job_reports_the_periods_it_dropped(
    observed_wpm: tuple[WorkerProcessManager, list[JobExecutionObservation]],
):
    """
    Test a pass that outlasts its period reports the periods that were skipped

    This is the only signal for the failure: the pool advances the job's
    period_start_ns by whole periods until it passes now, so no error is
    raised, no work is queued, and RTF *falls* as periods are lost because
    each surviving pass ingests more audio. SlowJob reports no counters of its
    own, so anything here came from the scheduler.
    """
    # Arrange
    wpm, observations = observed_wpm
    wpm.register_job((), OVERRUN_PERIOD_MS, SlowJob(OVERRUN_WORK_NS), "whisper")

    # Act
    await asyncio.sleep(OVERRUN_SETTLE_SEC)

    # Assert - the first pass cannot have dropped anything: nothing overran
    # before it.
    assert len(observations) >= 2
    assert observations[0].counters == {}

    # Assert - every pass after it reports at least the one period it spent
    # overrunning, attributed to the provider the job was labelled with.
    later = observations[1:]
    assert all(
        observation.counters.get(DROPPED_PERIODS_COUNTER, 0) >= 1
        for observation in later
    )
    assert all(observation.label == "whisper" for observation in later)


@pytest.mark.asyncio
async def test_job_that_fits_its_period_reports_no_dropped_periods(
    observed_wpm: tuple[WorkerProcessManager, list[JobExecutionObservation]],
):
    """
    Test the counter stays absent while passes finish inside their period

    The ordinary advance to the next period is one iteration of the same loop
    the drops are counted from, so an off-by-one here would report a dropped
    period on every healthy pass and make the whole signal worthless.
    """
    # Arrange
    wpm, observations = observed_wpm
    wpm.register_job((), JOB_PERIOD_MS, SumJob(), "whisper")

    # Act - several periods, so this covers the steady state and not just the
    # first pass
    await asyncio.sleep(JOB_PERIOD_MS * 3 / 1000 + SETTLE_SEC)

    # Assert
    assert len(observations) >= 3
    assert all(observation.counters == {} for observation in observations)
