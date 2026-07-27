"""
Defines MetricsRegistry, the in-memory store of transcription-service telemetry
"""

from src.shared.utils.worker_pool import (
    DROPPED_PERIODS_COUNTER,
    JobExecutionObservation,
)
from src.transcription_provider_interface import TranscriptionJobCounter
from src.webserver.shared.process_identity import (
    ProcessIdentity,
    create_process_identity,
)

from .metric_types import (
    DEFAULT_MAX_SAMPLES,
    DEFAULT_RETENTION_SEC,
    Counter,
    Histogram,
)

NS_PER_MS = 1_000_000
NS_PER_SEC = 1_000_000_000

# Label applied to executions whose job carried no label. The label a job
# execution reports travels with its own JobExecutionResult, stamped at
# registration (see RegisterJobTask.label), so this is reachable only when the
# caller registered the job with no label to begin with - never merely because
# the job was since deregistered, which is exactly the case a saturation
# collapse produces in bulk. It is named rather than dropped so that it is
# visible if it does turn up.
UNLABELED_PROVIDER = "unknown"


class MetricsRegistry:
    """
    Process-wide store of transcription-service telemetry

    Owns the counters and histograms that PLAN-B1.2 exposes over
    `/metrics/status`. Everything here is monotonic since process start and
    nothing is persisted, so consumers difference successive reads and compare
    `process_uid` first - a restart returns every counter to zero and would
    otherwise read as a large negative rate.

    Series are labelled by provider, never by session: the retained-sample
    histograms are bounded per series, so a per-session label would let the
    response grow with the number of sessions the process has ever served.
    """

    @property
    def process_uid(self) -> str:
        """
        Gets identifier unique to this process instance

        Changes on every restart, which is how a consumer distinguishes a
        counter reset from a counter decrease.
        """
        return self._process_uid

    @property
    def process_started_at(self) -> str:
        """
        Gets ISO 8601 UTC timestamp of when this registry was constructed
        """
        return self._process_started_at

    def __init__(
        self,
        max_histogram_samples: int = DEFAULT_MAX_SAMPLES,
        process_identity: ProcessIdentity | None = None,
        histogram_retention_sec: float = DEFAULT_RETENTION_SEC,
    ):
        """
        Args:
            max_histogram_samples - Retained observations per histogram series
            process_identity      - Identity to report; one is created when
                                      omitted. Pass the process-wide instance so
                                      every telemetry endpoint reports the same
                                      uid, which is what lets a consumer
                                      correlate counters across them.
            histogram_retention_sec - Age at which a retained observation stops
                                      counting toward the reported percentiles.
                                      Raise it for a deployment whose
                                      `job_period_ms` is large enough that the
                                      default window holds only a few dozen
                                      samples; see DEFAULT_RETENTION_SEC.
        """
        identity = process_identity or create_process_identity()
        self._process_uid = identity.process_uid
        self._process_started_at = identity.process_started_at

        self.jobs_completed_total = Counter(
            "jobs_completed_total",
            "Job executions that returned a result, by provider",
        )
        self.jobs_failed_total = Counter(
            "jobs_failed_total",
            "Job executions that raised, by provider and exception class",
        )

        # Every histogram shares one retention window. The reported percentiles
        # are read side by side on one dashboard panel, so a per-metric window
        # would mean a p95 execution time and a p95 RTF that summarise different
        # spans of time and cannot be reconciled by eye.
        self.asr_scheduling_delay_ms = Histogram(
            "asr_scheduling_delay_ms",
            "Time a job waited between becoming ready and being scheduled",
            max_histogram_samples,
            histogram_retention_sec,
        )
        self.asr_execution_ms = Histogram(
            "asr_execution_ms",
            "Time a job spent executing",
            max_histogram_samples,
            histogram_retention_sec,
        )
        self.asr_total_ms = Histogram(
            "asr_total_ms",
            "Total time a job spent in the worker pool",
            max_histogram_samples,
            histogram_retention_sec,
        )
        self.asr_rtf = Histogram(
            "asr_rtf",
            "Wall-clock seconds spent per second of ingested audio",
            max_histogram_samples,
            histogram_retention_sec,
        )

        self.asr_audio_seconds_total = Counter(
            "asr_audio_seconds_total",
            "Seconds of audio decoded and ingested, by provider",
        )
        self.buffer_overflow_total = Counter(
            "buffer_overflow_total",
            "Times the audio buffer filled and audio was force-finalized",
        )
        self.buffer_overflow_seconds_total = Counter(
            "buffer_overflow_seconds_total",
            "Seconds of audio discarded by those force-finalizations",
        )
        self.audio_dropped_buffer_full_total = Counter(
            "audio_dropped_buffer_full_total",
            "Times a decode batch overran the audio buffer and its tail was "
            "dropped",
        )
        self.audio_dropped_buffer_full_seconds_total = Counter(
            "audio_dropped_buffer_full_seconds_total",
            "Seconds of audio dropped because the buffer was full",
        )
        self.vad_no_speech_total = Counter(
            "vad_no_speech_total",
            "Executions where VAD found no speech in the buffer",
        )
        self.decode_drops_total = Counter(
            "decode_drops_total",
            "Audio frames dropped because they failed to decode, by provider",
        )
        self.no_words_total = Counter(
            "no_words_total",
            "Executions that transcribed no words from a non-empty buffer",
        )
        self.compression_ratio_guard_fired_total = Counter(
            "compression_ratio_guard_fired_total",
            "Segments where Whisper's compression_ratio exceeded its guard "
            "threshold, a hallucination risk signal",
        )
        self.avg_logprob_guard_fired_total = Counter(
            "avg_logprob_guard_fired_total",
            "Segments where Whisper's avg_logprob fell below its guard "
            "threshold, a hallucination risk signal",
        )
        self.no_speech_prob_guard_fired_total = Counter(
            "no_speech_prob_guard_fired_total",
            "Segments where Whisper's no_speech_prob exceeded its guard "
            "threshold, a hallucination risk signal",
        )
        self.temperature_fallback_total = Counter(
            "temperature_fallback_total",
            "Segments where Whisper fell back to a higher sampling "
            "temperature, a hallucination risk signal",
        )
        self.repeated_segment_detected_total = Counter(
            "repeated_segment_detected_total",
            "Finalized segments whose text substantially overlaps the "
            "previously finalized segment",
        )

        # The one counter here that describes the *scheduler* rather than the
        # work: periods in which a job never ran, because the pass before it
        # overran and the pool drops missed periods instead of queueing them.
        # Worth reporting even for a single session - a lone stream whose
        # unfinalized buffer grows past what one period can transcribe drops
        # periods while every other number, RTF included, still looks healthy.
        # It arrives on the same per-execution counters dict as everything
        # above, written there by the pool, so it needs no separate transport.
        self.asr_dropped_periods_total = Counter(
            "asr_dropped_periods_total",
            "Job periods skipped because the previous pass overran, "
            "by provider",
        )

        self._worker_counters = {
            TranscriptionJobCounter.BUFFER_OVERFLOW: self.buffer_overflow_total,
            TranscriptionJobCounter.BUFFER_OVERFLOW_SECONDS: (
                self.buffer_overflow_seconds_total
            ),
            TranscriptionJobCounter.AUDIO_DROPPED_BUFFER_FULL: (
                self.audio_dropped_buffer_full_total
            ),
            TranscriptionJobCounter.AUDIO_DROPPED_BUFFER_FULL_SECONDS: (
                self.audio_dropped_buffer_full_seconds_total
            ),
            TranscriptionJobCounter.VAD_NO_SPEECH: self.vad_no_speech_total,
            TranscriptionJobCounter.NO_WORDS: self.no_words_total,
            TranscriptionJobCounter.AUDIO_SECONDS_DECODED: (
                self.asr_audio_seconds_total
            ),
            TranscriptionJobCounter.COMPRESSION_RATIO_GUARD_FIRED: (
                self.compression_ratio_guard_fired_total
            ),
            TranscriptionJobCounter.AVG_LOGPROB_GUARD_FIRED: (
                self.avg_logprob_guard_fired_total
            ),
            TranscriptionJobCounter.NO_SPEECH_PROB_GUARD_FIRED: (
                self.no_speech_prob_guard_fired_total
            ),
            TranscriptionJobCounter.TEMPERATURE_FALLBACK: (
                self.temperature_fallback_total
            ),
            TranscriptionJobCounter.REPEATED_SEGMENT_DETECTED: (
                self.repeated_segment_detected_total
            ),
            # Keyed by the pool's own constant, not a TranscriptionJobCounter:
            # the worker pool knows nothing about transcription and the
            # scheduler, not a job, is what reports this.
            DROPPED_PERIODS_COUNTER: self.asr_dropped_periods_total,
        }

    def record_decode_drop(self, provider_key: str) -> None:
        """
        Counts one audio frame dropped because it failed to decode

        Unlike everything else here this happens in the FastAPI process, not a
        worker - it is a framing failure, so the frame never reaches a job.

        Args:
            provider_key    - Provider the connection was opened against
        """
        self.decode_drops_total.inc(
            {"provider_key": provider_key or UNLABELED_PROVIDER}
        )

    def _record_worker_counters(
        self, counters: dict[str, float], labels: dict[str, str]
    ) -> None:
        """
        Folds one execution's worker-side counter deltas into the totals

        Args:
            counters    - Per-execution deltas reported by the job
            labels      - Label set to record them under

        Unknown names are ignored rather than auto-registered: a typo in a job
        should not silently create a metric nobody consumes, and the response
        shape must stay fixed for the sidecar.
        """
        for name, delta in counters.items():
            counter = self._worker_counters.get(name)
            if counter is not None:
                counter.inc(labels, delta)

    def record_job_execution(
        self, observation: JobExecutionObservation
    ) -> None:
        """
        Folds one completed job execution into the registry

        Hooked to the worker pool rather than to any individual provider, so a
        provider added later is instrumented without further work.

        Args:
            observation - Completed job execution reported by the worker pool
        """
        provider_key = observation.label or UNLABELED_PROVIDER
        labels = {"provider_key": provider_key}

        # Timings are recorded for failed executions too: a job that raises
        # still consumed worker time, and excluding it would flatter the
        # numbers exactly when the service is unhealthy.
        stats = observation.stats
        self.asr_scheduling_delay_ms.observe(
            stats.scheduling_delay_ns / NS_PER_MS, labels
        )
        self.asr_execution_ms.observe(
            stats.execution_time_ns / NS_PER_MS, labels
        )
        self.asr_total_ms.observe(stats.total_time_ns / NS_PER_MS, labels)

        self._record_worker_counters(observation.counters, labels)

        # Real RTF, at last: wall-clock seconds per second of audio ingested.
        # NOT computed over VAD-kept audio only - wall-clock cost per second of
        # *ingested* audio is the capacity number, and excluding silence would
        # flatter the figure exactly when VAD is discarding the most.
        audio_seconds = observation.counters.get(
            TranscriptionJobCounter.AUDIO_SECONDS_DECODED, 0
        )
        if audio_seconds > 0:
            self.asr_rtf.observe(
                (stats.execution_time_ns / NS_PER_SEC) / audio_seconds, labels
            )

        if observation.exception is None:
            self.jobs_completed_total.inc(labels)
            return

        # The exception class, never its message: messages carry session ids
        # and file paths, so a message label would be unbounded cardinality.
        self.jobs_failed_total.inc(
            {
                "provider_key": provider_key,
                "reason": type(observation.exception).__name__,
            }
        )
