"""
Unit tests for CapacityEstimator (PLAN-AdmissionControl.md §3/§6)

Every test drives the estimator with synthetic JobExecutionObservations
carrying explicit timestamps, so the sliding window is exercised without a
real worker pool, a real clock, or any sleeping - the estimator's notion of
"now" is the newest completion it has been shown.
"""

# pylint: disable=protected-access

from src.shared.utils.worker_pool import (
    DROPPED_PERIODS_COUNTER,
    CapacityEstimator,
    JobExecutionObservation,
    JobStatistics,
)

WORKER_ID = 7

# Short window so a test can evict it entirely with a modest time jump. The
# window length is not what any of these tests are about.
WINDOW_SEC = 5.0

NS_PER_SEC = 1000000000


def observation(
    job_id: int,
    start_sec: float,
    execution_sec: float,
    dropped_periods: float = 0.0,
    worker_id: int = WORKER_ID,
) -> JobExecutionObservation:
    """One completed pass, timestamped in seconds for readability."""
    start_ns = int(start_sec * NS_PER_SEC)
    complete_ns = start_ns + int(execution_sec * NS_PER_SEC)
    counters = (
        {DROPPED_PERIODS_COUNTER: dropped_periods} if dropped_periods else {}
    )
    return JobExecutionObservation(
        worker_id=worker_id,
        job_id=job_id,
        label="whisper",
        stats=JobStatistics(
            period_start_ns=start_ns,
            job_scheduled_time_ns=start_ns,
            start_execute_time_ns=start_ns,
            complete_time_ns=complete_ns,
        ),
        exception=None,
        counters=counters,
    )


def feed(
    estimator: CapacityEstimator,
    *,
    passes: int,
    execution_sec: float,
    period_sec: float,
    jobs: int = 1,
    dropped_periods: float = 0.0,
    first_job_id: int = 0,
    start_sec: float = 0.0,
    worker_id: int = WORKER_ID,
) -> float:
    """
    Feeds `passes` periods of `jobs` sessions round-robinning one worker.

    Each period runs every job back to back, which is what the worker's single
    job loop really does, so the resulting busy fraction is very close to
    `jobs * execution_sec / period_sec`.

    Returns the wall time (sec) just past the last completion, so a caller can
    place a following phase relative to it.
    """
    now = start_sec
    for index in range(passes):
        now = start_sec + index * period_sec
        for job in range(jobs):
            estimator.record(
                observation(
                    job_id=first_job_id + job,
                    start_sec=now,
                    execution_sec=execution_sec,
                    dropped_periods=dropped_periods,
                    worker_id=worker_id,
                )
            )
            now += execution_sec
    return now


def make_estimator(
    target_busy: float = 0.85,
    min_sessions: int = 1,
    max_sessions: int | None = None,
) -> CapacityEstimator:
    """An estimator on the short test window."""
    return CapacityEstimator(
        target_busy=target_busy,
        min_sessions=min_sessions,
        max_sessions=max_sessions,
        window_seconds=WINDOW_SEC,
    )


def establish_clean_baseline(
    estimator: CapacityEstimator, execution_sec: float = 0.5
) -> None:
    """
    Drives one relaxed session until the estimator has a trusted `b`.

    One 0.5s pass per 1s period is ~50% busy with no dropped periods: well
    inside both ratchet gates, and long enough to clear warm-up.
    """
    feed(
        estimator,
        passes=12,
        execution_sec=execution_sec,
        period_sec=1.0,
        jobs=1,
    )


def test_busy_window_does_not_update_the_stored_cost():
    """
    A window with busy >= 0.9 is refused as a basis for `b`.

    This is the censored-measurement case: once the worker is pinned, measured
    per-session cost stops tracking real per-session cost, because the work
    that got skipped is not in the numerator.
    """
    # Arrange - a clean baseline, then evict it entirely
    estimator = make_estimator()
    establish_clean_baseline(estimator)
    baseline = estimator.snapshot(WORKER_ID, 1).cost_per_session
    assert baseline is not None

    # Act - 4 sessions x 0.25s per 1s period pins the worker at 100% busy,
    # with no dropped periods at all, so only the busy gate can refuse it
    feed(
        estimator,
        passes=12,
        execution_sec=0.25,
        period_sec=1.0,
        jobs=4,
        first_job_id=100,
        start_sec=1000.0,
    )

    # Assert - the window really is saturated, and `b` did not move
    after = estimator.snapshot(WORKER_ID, 4)
    assert after.busy is not None and after.busy >= 0.9
    assert after.drop_share == 0
    assert after.cost_per_session == baseline


def test_elevated_drop_share_window_does_not_update_the_stored_cost():
    """
    A window with drop share >= 0.5 is refused as a basis for `b`.

    Dropped periods make the worker look *cheap* - each surviving pass covers
    the audio the skipped ones never touched - so a low busy fraction under
    heavy drops is exactly the reading that must not be trusted.
    """
    # Arrange
    estimator = make_estimator()
    establish_clean_baseline(estimator)
    baseline = estimator.snapshot(WORKER_ID, 1).cost_per_session
    assert baseline is not None

    # Act - only 10% busy, but two periods dropped for every pass that ran
    feed(
        estimator,
        passes=12,
        execution_sec=0.1,
        period_sec=1.0,
        jobs=1,
        dropped_periods=2.0,
        first_job_id=100,
        start_sec=1000.0,
    )

    # Assert - the window looks idle and would imply a far cheaper session,
    # but the drop share disqualifies it
    after = estimator.snapshot(WORKER_ID, 1)
    assert after.busy is not None and after.busy < 0.9
    assert after.drop_share is not None and after.drop_share >= 0.5
    assert after.cost_per_session == baseline


def test_estimate_never_rises_while_drops_are_elevated():
    """
    A degraded window that would naively imply a *higher* ceiling does not
    raise it.

    The historical failure, three times over in this subsystem: the guard's
    own measurement is corrupted by the failure it exists to catch. Here a
    collapsing worker reads as 100% busy across 4 sessions, so a naive
    `b = busy / N` computes 1.0/4 = 0.25 and a naive
    `floor(0.85 / 0.25) = 3` - a ceiling three times the one measured while
    the worker was healthy, raised at the exact moment the service is falling
    over.
    """
    # Arrange - one heavy session, ~80% busy, gives a trusted ceiling of 1
    estimator = make_estimator()
    establish_clean_baseline(estimator, execution_sec=0.8)
    before = estimator.snapshot(WORKER_ID, 1)
    assert before.estimated_capacity_sessions == 1

    # Act - the collapse: 4 sessions, worker pinned, most periods dropped
    feed(
        estimator,
        passes=12,
        execution_sec=0.25,
        period_sec=1.0,
        jobs=4,
        dropped_periods=2.0,
        first_job_id=100,
        start_sec=1000.0,
    )

    # Assert - the naive recompute this test exists to forbid
    after = estimator.snapshot(WORKER_ID, 4)
    assert after.busy is not None and after.busy >= 0.9
    assert after.drop_share is not None and after.drop_share >= 0.5
    naive_ceiling = int(0.85 / (after.busy / 4))
    assert naive_ceiling > before.estimated_capacity_sessions

    # Assert - the ceiling held instead of rising to the naive value
    assert after.estimated_capacity_sessions == 1
    assert not estimator.admit(WORKER_ID, 1)


def test_a_clean_window_may_raise_the_estimate():
    """
    The ratchet is one-way only while degraded - a healthy window still raises
    the ceiling.

    Without this, "never rises" would be satisfiable by an estimator that
    never rises at all, which would converge on the worst window it ever saw
    and refuse sessions forever after one bad minute.
    """
    # Arrange - one heavy session, ~80% busy, ceiling 1
    estimator = make_estimator()
    establish_clean_baseline(estimator, execution_sec=0.8)
    assert estimator.snapshot(WORKER_ID, 1).estimated_capacity_sessions == 1

    # Act - load eases off to ~10% busy on one session, no drops
    feed(
        estimator,
        passes=12,
        execution_sec=0.1,
        period_sec=1.0,
        jobs=1,
        first_job_id=100,
        start_sec=1000.0,
    )

    # Assert
    after = estimator.snapshot(WORKER_ID, 1)
    assert after.estimated_capacity_sessions is not None
    assert after.estimated_capacity_sessions > 1
    assert estimator.admit(WORKER_ID, 1)


def test_zero_live_sessions_always_admits():
    """
    N == 0 admits unconditionally, in every state the estimator can be in.

    There is nothing to be too busy with, and the cold-start case must never
    wait on a measurement it cannot have yet.
    """
    # Arrange / Assert - before any record() call at all
    estimator = make_estimator()
    assert estimator.admit(WORKER_ID, 0)

    # Act - a measured ceiling of 1, then the worst state reachable from it:
    # pinned and dropping, so the estimator is actively refusing
    establish_clean_baseline(estimator, execution_sec=0.8)
    feed(
        estimator,
        passes=12,
        execution_sec=0.25,
        period_sec=1.0,
        jobs=4,
        dropped_periods=2.0,
        first_job_id=100,
        start_sec=1000.0,
    )

    # Assert - still admits at N == 0, while refusing at the live count
    assert estimator.admit(WORKER_ID, 0)
    assert not estimator.admit(WORKER_ID, 4)


def test_min_sessions_floors_the_estimate_from_a_bad_measurement():
    """
    A measurement implying a ceiling of 1 still reports min_sessions.

    The floor is what stops a mis-measurement from taking a worker to zero
    admissions; it applies to a real (if pessimistic, or ratchet-held stale)
    measurement.
    """
    # Arrange - ~80% busy on a single session implies floor(0.85/0.8) = 1
    estimator = make_estimator(min_sessions=3)
    establish_clean_baseline(estimator, execution_sec=0.8)

    # Assert - the raw measurement is the low one, the reported ceiling is not
    snapshot = estimator.snapshot(WORKER_ID, 1)
    assert snapshot.cost_per_session is not None
    assert int(0.85 / snapshot.cost_per_session) == 1
    assert snapshot.estimated_capacity_sessions == 3
    assert estimator.admit(WORKER_ID, 2)
    assert not estimator.admit(WORKER_ID, 3)


def test_warm_up_reports_unknown_rather_than_min_sessions():
    """
    Before 5 clean samples the estimate is None, even with min_sessions set.

    The ordering that is easy to get backwards: min_sessions floors a *bad*
    measurement, it does not stand in for *no* measurement. Publishing the
    floor during warm-up would put a fabricated number in the same field a
    measured one arrives in, and no consumer could tell them apart.
    """
    # Arrange - 6 passes: 3 discarded as warm-up, 3 recorded, of which only
    # the 2nd and 3rd land in a window big enough to have a busy fraction
    estimator = make_estimator(min_sessions=3)
    feed(estimator, passes=6, execution_sec=0.5, period_sec=1.0)

    # Assert - unknown, not 3
    warming = estimator.snapshot(WORKER_ID, 1)
    assert warming.estimated_capacity_sessions is None
    assert estimator.admit(WORKER_ID, 1)

    # Act - keep going until enough clean samples have accumulated
    feed(estimator, passes=8, execution_sec=0.5, period_sec=1.0, start_sec=6.0)

    # Assert - now a real number, floored by min_sessions
    assert estimator.snapshot(WORKER_ID, 1).estimated_capacity_sessions == 3


def test_first_three_passes_of_a_job_are_discarded():
    """
    A job's first 3 completed passes contribute nothing to the window.

    Model and context warm-up make early passes expensive in a way the steady
    state never repeats, and counting them would bias the ceiling down - the
    direction this plan refuses to err in, because a wrong refusal is
    invisible.
    """
    # Arrange / Act - exactly the discarded passes
    estimator = make_estimator()
    feed(estimator, passes=3, execution_sec=0.5, period_sec=1.0)

    # Assert - nothing at all reached window accounting
    assert estimator.snapshot(WORKER_ID, 1).busy is None
    assert estimator.snapshot(WORKER_ID, 1).drop_share is None

    # Act - two more passes from the same job
    feed(estimator, passes=2, execution_sec=0.5, period_sec=1.0, start_sec=3.0)

    # Assert - only those two are in the window
    snapshot = estimator.snapshot(WORKER_ID, 1)
    assert snapshot.busy is not None
    assert snapshot.drop_share == 0


def test_max_sessions_pins_the_estimate_and_disables_auto_tuning():
    """
    With max_sessions set, N* is exactly that number in every state.

    A pin is an operator statement about the deployment, so it holds during
    warm-up (before any measurement exists) and under collapse (when the
    measurement cannot be trusted) alike.
    """
    # Arrange - nothing recorded yet
    estimator = make_estimator(min_sessions=1, max_sessions=4)
    assert estimator.snapshot(WORKER_ID, 0).estimated_capacity_sessions == 4

    # Act - a healthy stretch that would auto-tune far above the pin
    feed(estimator, passes=12, execution_sec=0.05, period_sec=1.0)

    # Assert
    assert estimator.snapshot(WORKER_ID, 1).estimated_capacity_sessions == 4

    # Act - then a collapse that would auto-tune below it
    feed(
        estimator,
        passes=12,
        execution_sec=0.25,
        period_sec=1.0,
        jobs=4,
        dropped_periods=2.0,
        first_job_id=100,
        start_sec=1000.0,
    )

    # Assert - unmoved, and enforcing the pin
    assert estimator.snapshot(WORKER_ID, 4).estimated_capacity_sessions == 4
    assert estimator.admit(WORKER_ID, 3)
    assert not estimator.admit(WORKER_ID, 4)


def test_unrecognized_worker_reads_as_warm_up():
    """
    A worker_id never seen by record() behaves as warm-up, not as an error.

    Warm-up and never-seen are the same state - "no measurement" - and asking
    about an unknown worker must not create state for it, or a health endpoint
    polling every id it can think of would grow the map without bound.
    """
    # Arrange - a different worker has data; the one under test never will
    estimator = make_estimator(min_sessions=2)
    feed(estimator, passes=12, execution_sec=0.5, period_sec=1.0)

    # Act
    snapshot = estimator.snapshot(999, 3)

    # Assert
    assert snapshot.worker_id == 999
    assert snapshot.live_sessions == 3
    assert snapshot.estimated_capacity_sessions is None
    assert snapshot.busy is None
    assert snapshot.drop_share is None
    assert snapshot.cost_per_session is None
    assert estimator.admit(999, 3)
    assert 999 not in estimator._windows


def test_workers_are_estimated_independently():
    """
    One worker collapsing does not move another worker's estimate.

    The whole reason this is keyed per worker: a pool can run different
    providers on different workers, and a pool-wide average describes none of
    them.
    """
    # Arrange - worker A relaxed, worker B pinned and dropping
    estimator = make_estimator()
    feed(estimator, passes=12, execution_sec=0.1, period_sec=1.0, worker_id=1)
    feed(
        estimator,
        passes=12,
        execution_sec=0.25,
        period_sec=1.0,
        jobs=4,
        dropped_periods=2.0,
        first_job_id=100,
        worker_id=2,
    )

    # Assert
    relaxed = estimator.snapshot(1, 1)
    pinned = estimator.snapshot(2, 4)
    assert relaxed.estimated_capacity_sessions is not None
    assert relaxed.estimated_capacity_sessions > 4
    assert pinned.estimated_capacity_sessions is None
    assert estimator.admit(1, 1)


def test_a_worker_degraded_from_its_first_session_stays_unknown_and_permissive():
    """
    A worker that never has a clean window never leaves warm-up, and keeps
    admitting.

    Pins the one place this estimator's own guard is censored by the failure
    it detects, so that it is a known, tested tradeoff rather than a surprise:
    clean samples only accumulate from windows the ratchet accepted, so a
    deployment that is already degraded at one session (measured: 52.9% drop
    share at a single CPU session with `vad_detector: true`) reports "unknown"
    forever. Permissive is the deliberate choice - the alternative is
    publishing min_sessions as if it had been measured - and what makes it
    workable is that busy/drop_share on the snapshot distinguish this from an
    idle cold start.
    """
    # Arrange / Act - one session, degraded from its very first pass
    estimator = make_estimator(min_sessions=2)
    feed(
        estimator,
        passes=20,
        execution_sec=0.1,
        period_sec=1.0,
        jobs=1,
        dropped_periods=2.0,
    )

    # Assert - no estimate ever formed, so nothing is refused
    snapshot = estimator.snapshot(WORKER_ID, 1)
    assert snapshot.estimated_capacity_sessions is None
    assert snapshot.cost_per_session is None
    assert estimator.admit(WORKER_ID, 1)
    assert estimator.admit(WORKER_ID, 20)

    # Assert - and it is not mistakable for an idle cold start
    assert snapshot.drop_share is not None and snapshot.drop_share >= 0.5


def test_snapshot_echoes_the_live_session_count_it_was_given():
    """
    live_sessions is the caller's number, echoed back untouched.

    This class deliberately does not track N: WorkerSnapshot.live_job_count is
    already the robust source, and a second copy would eventually disagree
    with the first.
    """
    # Arrange
    estimator = make_estimator()
    establish_clean_baseline(estimator)

    # Act / Assert
    assert estimator.snapshot(WORKER_ID, 0).live_sessions == 0
    assert estimator.snapshot(WORKER_ID, 42).live_sessions == 42
