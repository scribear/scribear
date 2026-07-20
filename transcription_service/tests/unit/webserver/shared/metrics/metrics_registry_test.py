"""
Unit tests for MetricsRegistry
"""

from src.shared.utils.worker_pool import JobExecutionObservation, JobStatistics
from src.webserver.shared.metrics import MetricsRegistry

NS_PER_MS = 1_000_000


def make_observation(
    label: str = "whisper",
    scheduling_delay_ms: float = 1,
    execution_ms: float = 2,
    exception: Exception | None = None,
) -> JobExecutionObservation:
    """
    Builds an observation with the given derived timings

    JobStatistics exposes only raw timestamps, so the derived properties are
    produced by placing the four timestamps at the right offsets.

    Args:
        label               - Job label, i.e. the provider key
        scheduling_delay_ms - Desired scheduling_delay_ns, in milliseconds
        execution_ms        - Desired execution_time_ns, in milliseconds
        exception           - Exception the execution raised, if any
    """
    period_start_ns = 0
    job_scheduled_time_ns = int(scheduling_delay_ms * NS_PER_MS)
    start_execute_time_ns = job_scheduled_time_ns
    complete_time_ns = start_execute_time_ns + int(execution_ms * NS_PER_MS)

    return JobExecutionObservation(
        worker_id=0,
        job_id=0,
        label=label,
        stats=JobStatistics(
            period_start_ns=period_start_ns,
            job_scheduled_time_ns=job_scheduled_time_ns,
            start_execute_time_ns=start_execute_time_ns,
            complete_time_ns=complete_time_ns,
        ),
        exception=exception,
    )


def test_identity_is_stable_and_unique():
    """
    Test each registry gets its own uid, which is what makes a restart
    distinguishable from a counter decrease
    """
    # Arrange
    registry = MetricsRegistry()
    other = MetricsRegistry()

    # Assert
    assert registry.process_uid == registry.process_uid
    assert registry.process_uid != other.process_uid
    assert registry.process_started_at.endswith("+00:00")


def test_successful_execution_increments_completed_and_timings():
    """
    Test a successful job feeds both the completion counter and the histograms
    """
    # Arrange
    registry = MetricsRegistry()
    labels = {"provider_key": "whisper"}

    # Act
    registry.record_job_execution(
        make_observation(scheduling_delay_ms=4, execution_ms=6)
    )

    # Assert
    assert registry.jobs_completed_total.get(labels) == 1
    assert registry.jobs_failed_total.total() == 0

    scheduling = registry.asr_scheduling_delay_ms.summary(labels)
    execution = registry.asr_execution_ms.summary(labels)
    total = registry.asr_total_ms.summary(labels)
    assert scheduling is not None and scheduling.p50 == 4
    assert execution is not None and execution.p50 == 6
    assert total is not None and total.p50 == 10


def test_failed_execution_is_labelled_by_exception_class():
    """
    Test the failure reason is the exception class, not its message

    Messages carry session ids and paths, so a message label would be
    unbounded cardinality.
    """
    # Arrange
    registry = MetricsRegistry()

    # Act
    registry.record_job_execution(
        make_observation(exception=ValueError("session abc-123 exploded"))
    )

    # Assert
    assert (
        registry.jobs_failed_total.get(
            {"provider_key": "whisper", "reason": "ValueError"}
        )
        == 1
    )
    assert registry.jobs_completed_total.total() == 0


def test_failed_execution_still_records_timings():
    """
    Test a job that raised still counts against worker time

    Excluding failures would flatter the latency numbers exactly when the
    service is unhealthy.
    """
    # Arrange
    registry = MetricsRegistry()

    # Act
    registry.record_job_execution(
        make_observation(execution_ms=9, exception=RuntimeError("boom"))
    )

    # Assert
    summary = registry.asr_execution_ms.summary({"provider_key": "whisper"})
    assert summary is not None
    assert summary.count == 1
    assert summary.p50 == 9


def test_providers_are_kept_as_separate_series():
    """
    Test one provider's executions do not pool into another's

    A debug-provider job is trivial, so pooling it with whisper would read as
    headroom that does not exist.
    """
    # Arrange
    registry = MetricsRegistry()

    # Act
    registry.record_job_execution(
        make_observation(label="whisper", execution_ms=500)
    )
    registry.record_job_execution(
        make_observation(label="debug", execution_ms=1)
    )

    # Assert
    whisper = registry.asr_execution_ms.summary({"provider_key": "whisper"})
    debug = registry.asr_execution_ms.summary({"provider_key": "debug"})
    assert whisper is not None and whisper.p50 == 500
    assert debug is not None and debug.p50 == 1


def test_unlabelled_execution_is_named_rather_than_dropped():
    """
    Test an execution whose job was already deregistered is still counted

    It describes work the worker really did; dropping it would under-report
    exactly when jobs are churning.
    """
    # Arrange
    registry = MetricsRegistry()

    # Act
    registry.record_job_execution(make_observation(label=""))

    # Assert
    assert registry.jobs_completed_total.get({"provider_key": "unknown"}) == 1
