"""
Defines MetricsRegistry, the in-memory store of transcription-service telemetry
"""

import uuid
from datetime import datetime, timezone

from src.shared.utils.worker_pool import JobExecutionObservation
from src.transcription_provider_interface import TranscriptionJobCounter

from .metric_types import DEFAULT_MAX_SAMPLES, Counter, Histogram

NS_PER_MS = 1_000_000
NS_PER_SEC = 1_000_000_000

# Label applied to executions whose job carried no label. Only reachable when a
# result arrives after its job was deregistered, so it should stay near zero;
# it is named rather than dropped so that it is visible if it does not.
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

    def __init__(self, max_histogram_samples: int = DEFAULT_MAX_SAMPLES):
        """
        Args:
            max_histogram_samples - Retained observations per histogram series
        """
        self._process_uid = str(uuid.uuid4())
        self._process_started_at = datetime.now(timezone.utc).isoformat()

        self.jobs_completed_total = Counter(
            "jobs_completed_total",
            "Job executions that returned a result, by provider",
        )
        self.jobs_failed_total = Counter(
            "jobs_failed_total",
            "Job executions that raised, by provider and exception class",
        )

        self.asr_scheduling_delay_ms = Histogram(
            "asr_scheduling_delay_ms",
            "Time a job waited between becoming ready and being scheduled",
            max_histogram_samples,
        )
        self.asr_execution_ms = Histogram(
            "asr_execution_ms",
            "Time a job spent executing",
            max_histogram_samples,
        )
        self.asr_total_ms = Histogram(
            "asr_total_ms",
            "Total time a job spent in the worker pool",
            max_histogram_samples,
        )
        self.asr_rtf = Histogram(
            "asr_rtf",
            "Wall-clock seconds spent per second of ingested audio",
            max_histogram_samples,
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
        self.audio_too_fast_total = Counter(
            "audio_too_fast_total",
            "Times a client pushed audio faster than realtime",
        )
        self.vad_no_speech_total = Counter(
            "vad_no_speech_total",
            "Executions where VAD found no speech in the buffer",
        )
        self.no_words_total = Counter(
            "no_words_total",
            "Executions that transcribed no words from a non-empty buffer",
        )

        self._worker_counters = {
            TranscriptionJobCounter.BUFFER_OVERFLOW: self.buffer_overflow_total,
            TranscriptionJobCounter.BUFFER_OVERFLOW_SECONDS: (
                self.buffer_overflow_seconds_total
            ),
            TranscriptionJobCounter.AUDIO_TOO_FAST: self.audio_too_fast_total,
            TranscriptionJobCounter.VAD_NO_SPEECH: self.vad_no_speech_total,
            TranscriptionJobCounter.NO_WORDS: self.no_words_total,
            TranscriptionJobCounter.AUDIO_SECONDS_DECODED: (
                self.asr_audio_seconds_total
            ),
        }

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
