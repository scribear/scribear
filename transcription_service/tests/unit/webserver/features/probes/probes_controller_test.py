"""
Unit tests for readiness evaluation
"""

from src.shared.utils.worker_pool.worker_process_manager import WorkerSnapshot
from src.webserver.features.probes.probes_controller import evaluate_readiness


def snapshot(
    worker_id: int = 0,
    utilization: float = 0.0,
    live_job_count: int = 0,
    alive: bool = True,
) -> WorkerSnapshot:
    """
    Builds a worker snapshot with everything irrelevant defaulted
    """
    return WorkerSnapshot(
        worker_id=worker_id,
        utilization=utilization,
        live_job_count=live_job_count,
        total_jobs_registered=0,
        context_ids=set(),
        alive=alive,
    )


def test_idle_pool_is_ready():
    """
    Test that a pool with headroom reports plain ok
    """
    # Arrange
    snapshots = [snapshot(0), snapshot(1)]

    # Act
    report = evaluate_readiness(snapshots)

    # Assert
    assert report.ready is True
    assert report.degraded is False
    assert not report.checks


def test_empty_pool_is_not_ready():
    """
    Test that no workers at all is a hard fault, not merely idle
    """
    # Act
    report = evaluate_readiness([])

    # Assert
    assert report.ready is False
    assert "no worker processes" in report.checks["workers"]


def test_dead_worker_fails_readiness():
    """
    Test that a worker that exited after startup fails readiness

    This is the T9 signature the always-200 readiness could not see: nothing in
    the pool notices a worker dying, so jobs pinned to it hang forever.
    """
    # Arrange
    snapshots = [snapshot(0), snapshot(1, alive=False)]

    # Act
    report = evaluate_readiness(snapshots)

    # Assert
    assert report.ready is False
    assert report.degraded is False
    assert "worker ids: 1" in report.checks["workers"]


def test_dead_worker_reports_stranded_job_count():
    """
    Test that the check names how many in-flight jobs will never complete
    """
    # Arrange
    snapshots = [snapshot(0, live_job_count=3, alive=False)]

    # Act
    report = evaluate_readiness(snapshots)

    # Assert
    assert "3 in-flight jobs" in report.checks["workers"]


def test_dead_worker_outranks_saturation():
    """
    Test that a dead worker fails readiness even when the rest are saturated

    Saturation is a 200; a dead worker is a 503. The more serious verdict must
    win rather than being masked by the busier one.
    """
    # Arrange
    snapshots = [
        snapshot(0, utilization=1.0, live_job_count=1),
        snapshot(1, alive=False),
    ]

    # Act
    report = evaluate_readiness(snapshots)

    # Assert
    assert report.ready is False


def test_fully_saturated_pool_is_degraded_but_ready():
    """
    Test that saturation reports degraded with a 200, not a failure

    Failing readiness here would take the service out of rotation at its
    busiest moment, which is a self-inflicted outage rather than a diagnosis.
    """
    # Arrange
    snapshots = [
        snapshot(0, utilization=0.97, live_job_count=1),
        snapshot(1, utilization=0.99, live_job_count=2),
    ]

    # Act
    report = evaluate_readiness(snapshots)

    # Assert
    assert report.ready is True
    assert report.degraded is True
    assert "0.99" in report.checks["workers"]


def test_cold_start_is_not_reported_as_saturated():
    """
    Test that a just-booted idle worker is healthy, not degraded

    The rolling window reports 1.0 after a worker records busy time with no
    idle time yet - the exact state of a worker that has just created its
    contexts. Without corroborating against live jobs, every cold start would
    come up amber.
    """
    # Arrange
    snapshots = [
        snapshot(0, utilization=1.0, live_job_count=0),
        snapshot(1, utilization=1.0, live_job_count=0),
    ]

    # Act
    report = evaluate_readiness(snapshots)

    # Assert
    assert report.ready is True
    assert report.degraded is False


def test_one_worker_with_headroom_is_not_degraded():
    """
    Test that a partly-busy pool is healthy

    Degraded means *every* worker is pinned; one free worker means the pool can
    still take work, and reporting amber there would be noise.
    """
    # Arrange
    snapshots = [
        snapshot(0, utilization=1.0, live_job_count=1),
        snapshot(1, utilization=0.2),
    ]

    # Act
    report = evaluate_readiness(snapshots)

    # Assert
    assert report.ready is True
    assert report.degraded is False
