"""
Unit tests for MetricsRegistry
"""

from src.shared.utils.worker_pool import (
    DROPPED_PERIODS_COUNTER,
    JobExecutionObservation,
    JobStatistics,
)
from src.transcription_provider_interface import TranscriptionJobCounter
from src.webserver.shared.metrics import MetricsRegistry

NS_PER_MS = 1_000_000


def make_observation(
    label: str = "whisper",
    scheduling_delay_ms: float = 1,
    execution_ms: float = 2,
    exception: Exception | None = None,
    counters: dict[str, float] | None = None,
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
        counters            - Worker-side per-execution counter deltas
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
        counters=counters or {},
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


def test_worker_side_counters_are_accumulated():
    """
    Test per-execution deltas from inside the worker become monotonic totals

    The worker reports deltas rather than running totals so the parent owns
    the totals - which is what makes a worker restart harmless.
    """
    # Arrange
    registry = MetricsRegistry()
    labels = {"provider_key": "whisper"}

    # Act
    for _ in range(2):
        registry.record_job_execution(
            make_observation(
                counters={
                    TranscriptionJobCounter.BUFFER_OVERFLOW: 1,
                    TranscriptionJobCounter.BUFFER_OVERFLOW_SECONDS: 1.5,
                    TranscriptionJobCounter.AUDIO_DROPPED_BUFFER_FULL: 1,
                    TranscriptionJobCounter.AUDIO_DROPPED_BUFFER_FULL_SECONDS: (
                        2.5
                    ),
                    TranscriptionJobCounter.VAD_NO_SPEECH: 1,
                    TranscriptionJobCounter.NO_WORDS: 1,
                    TranscriptionJobCounter.AUDIO_SECONDS_DECODED: 4,
                }
            )
        )

    # Assert
    assert registry.buffer_overflow_total.get(labels) == 2
    assert registry.buffer_overflow_seconds_total.get(labels) == 3
    assert registry.audio_dropped_buffer_full_total.get(labels) == 2
    assert registry.audio_dropped_buffer_full_seconds_total.get(labels) == 5
    assert registry.vad_no_speech_total.get(labels) == 2
    assert registry.no_words_total.get(labels) == 2
    assert registry.asr_audio_seconds_total.get(labels) == 8


def test_worker_side_quality_guard_counters_are_accumulated():
    """
    Test the B2.3 quality-guard deltas fold into monotonic totals the same
    way the pre-existing worker-side counters do
    """
    # Arrange
    registry = MetricsRegistry()
    labels = {"provider_key": "whisper"}

    # Act
    for _ in range(2):
        registry.record_job_execution(
            make_observation(
                counters={
                    TranscriptionJobCounter.COMPRESSION_RATIO_GUARD_FIRED: 1,
                    TranscriptionJobCounter.AVG_LOGPROB_GUARD_FIRED: 1,
                    TranscriptionJobCounter.NO_SPEECH_PROB_GUARD_FIRED: 1,
                    TranscriptionJobCounter.TEMPERATURE_FALLBACK: 1,
                    TranscriptionJobCounter.REPEATED_SEGMENT_DETECTED: 1,
                }
            )
        )

    # Assert
    assert registry.compression_ratio_guard_fired_total.get(labels) == 2
    assert registry.avg_logprob_guard_fired_total.get(labels) == 2
    assert registry.no_speech_prob_guard_fired_total.get(labels) == 2
    assert registry.temperature_fallback_total.get(labels) == 2
    assert registry.repeated_segment_detected_total.get(labels) == 2


def test_unknown_counter_names_are_ignored():
    """
    Test a name the registry does not know does not create a metric

    The response shape is a contract with the sidecar; a typo in a job should
    not silently extend it.
    """
    # Arrange
    registry = MetricsRegistry()

    # Act
    registry.record_job_execution(
        make_observation(counters={"buffer_overfow": 99})
    )

    # Assert
    assert registry.buffer_overflow_total.total() == 0


def test_rtf_is_execution_time_over_audio_ingested():
    """
    Test real RTF is derived from the audio duration the worker reports

    This is the number the period-utilization proxy was standing in for: 0.5
    means the model took half a second of wall clock per second of audio.
    """
    # Arrange
    registry = MetricsRegistry()

    # Act
    registry.record_job_execution(
        make_observation(
            execution_ms=500,
            counters={TranscriptionJobCounter.AUDIO_SECONDS_DECODED: 1},
        )
    )

    # Assert
    summary = registry.asr_rtf.summary({"provider_key": "whisper"})
    assert summary is not None
    assert summary.p50 == 0.5


def test_rtf_is_not_recorded_without_audio():
    """
    Test an execution that ingested no audio contributes no RTF sample

    Jobs run every period whether or not audio arrived, so recording those
    would divide by zero - and, if defaulted, would flood the histogram with
    meaningless samples that drag the percentiles.
    """
    # Arrange
    registry = MetricsRegistry()

    # Act
    registry.record_job_execution(make_observation(execution_ms=500))

    # Assert
    assert registry.asr_rtf.summary({"provider_key": "whisper"}) is None


def test_failed_execution_still_reports_its_counters():
    """
    Test counters incremented before a raise are not lost

    A batch is decoded chunk by chunk, so a chunk that fails to decode raises
    after earlier chunks in the same batch were already counted. A drain that
    skipped failures would lose that work entirely.
    """
    # Arrange
    registry = MetricsRegistry()

    # Act
    registry.record_job_execution(
        make_observation(
            exception=RuntimeError("Invalid audio data."),
            counters={TranscriptionJobCounter.AUDIO_SECONDS_DECODED: 1.5},
        )
    )

    # Assert
    assert (
        registry.asr_audio_seconds_total.get({"provider_key": "whisper"}) == 1.5
    )


def test_dropped_periods_are_accumulated_per_provider():
    """
    Test the scheduler's dropped-period count reaches the per-provider total

    It rides the same counters dict as the job's own counters but is written by
    the worker pool, so this checks the registry does not need to know the
    difference - and that a provider that dropped nothing stays at zero rather
    than borrowing another provider's count.
    """
    # Arrange
    registry = MetricsRegistry()

    # Act
    registry.record_job_execution(
        make_observation(counters={DROPPED_PERIODS_COUNTER: 2})
    )
    registry.record_job_execution(
        make_observation(counters={DROPPED_PERIODS_COUNTER: 3})
    )
    registry.record_job_execution(make_observation(label="lumen_granite"))

    # Assert
    assert (
        registry.asr_dropped_periods_total.get({"provider_key": "whisper"}) == 5
    )
    assert (
        registry.asr_dropped_periods_total.get(
            {"provider_key": "lumen_granite"}
        )
        == 0
    )


def test_decode_drops_are_counted_per_provider():
    """
    Test framing failures are counted in the process that sees them

    A frame that fails to decode never reaches a worker, so this is the one
    counter here with no job behind it.
    """
    # Arrange
    registry = MetricsRegistry()

    # Act
    registry.record_decode_drop("whisper")
    registry.record_decode_drop("whisper")
    registry.record_decode_drop("")

    # Assert
    assert registry.decode_drops_total.get({"provider_key": "whisper"}) == 2
    assert registry.decode_drops_total.get({"provider_key": "unknown"}) == 1
