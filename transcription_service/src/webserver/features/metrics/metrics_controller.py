"""
Defines MetricsController that shapes the metrics registry into a JSON body
"""

from typing import Any

from src.webserver.shared.metrics import Counter, Histogram, MetricsRegistry
from src.webserver.shared.transcription_provider_registry import (
    TranscriptionProviderRegistry,
)
from src.webserver.shared.worker_view import serialize_worker


def _counter_series(counter: Counter) -> list[dict[str, Any]]:
    """
    Serializes every series of a counter

    Args:
        counter - Counter to serialize

    Returns:
        List of {labels, value} entries, one per label set
    """
    return [
        {"labels": entry.labels, "value": entry.value}
        for entry in counter.entries()
    ]


def _histogram_series(histogram: Histogram) -> list[dict[str, Any]]:
    """
    Serializes every series of a histogram as summary statistics

    Raw samples are deliberately not exposed: they are an implementation
    detail of how exact percentiles are computed, and a response carrying
    thousands of them per series would be unusable.

    Args:
        histogram   - Histogram to serialize

    Returns:
        List of {labels, ...summary} entries, one per label set
    """
    series: list[dict[str, Any]] = []
    for labels in histogram.series_labels():
        summary = histogram.summary(labels)
        if summary is None:
            continue
        series.append(
            {
                "labels": labels,
                "count": summary.count,
                "sum": summary.sum,
                "sampleCount": summary.sample_count,
                "min": summary.minimum,
                "max": summary.maximum,
                "mean": summary.mean,
                "p50": summary.p50,
                "p95": summary.p95,
                "p99": summary.p99,
            }
        )
    return series


class MetricsController:
    """
    Builds the `/metrics/status` response body

    Reads only: every collaborator it touches exposes side-effect-free
    accessors, so a poll can never perturb transcription.
    """

    def __init__(
        self,
        metrics_registry: MetricsRegistry,
        provider_registry: TranscriptionProviderRegistry,
    ):
        """
        Args:
            metrics_registry    - In-memory telemetry store
            provider_registry   - Owner of the worker pool and providers
        """
        self._metrics = metrics_registry
        self._providers = provider_registry

    def status(self) -> dict[str, Any]:
        """
        Gets the current telemetry snapshot

        Counters are monotonic since process start and are never reset;
        consumers difference successive reads to obtain rates, and must
        compare `processUid` first, because a restart returns every counter to
        zero and would otherwise read as a large negative rate.
        """
        return {
            "processUid": self._metrics.process_uid,
            "processStartedAt": self._metrics.process_started_at,
            # The deployed value of this has been an open question for the
            # capacity model. It defaults to 1 in every provider_config
            # template, which means every room serializes through one model
            # process - so it is worth reporting even when it is boring.
            "numWorkers": self._providers.num_workers,
            "providerKeys": self._providers.provider_keys,
            "workers": [
                serialize_worker(snapshot)
                for snapshot in self._providers.worker_snapshots()
            ],
            "counters": {
                "jobsCompletedTotal": _counter_series(
                    self._metrics.jobs_completed_total
                ),
                "jobsFailedTotal": _counter_series(
                    self._metrics.jobs_failed_total
                ),
                "asrAudioSecondsTotal": _counter_series(
                    self._metrics.asr_audio_seconds_total
                ),
                "bufferOverflowTotal": _counter_series(
                    self._metrics.buffer_overflow_total
                ),
                "bufferOverflowSecondsTotal": _counter_series(
                    self._metrics.buffer_overflow_seconds_total
                ),
                "audioTooFastTotal": _counter_series(
                    self._metrics.audio_too_fast_total
                ),
                "vadNoSpeechTotal": _counter_series(
                    self._metrics.vad_no_speech_total
                ),
                "noWordsTotal": _counter_series(self._metrics.no_words_total),
                # The one counter here that is incremented in the FastAPI
                # process rather than a worker: a frame that fails to decode
                # never reaches a job.
                "decodeDropsTotal": _counter_series(
                    self._metrics.decode_drops_total
                ),
                # Whisper's own hallucination-risk signals (B2.3). Firing is
                # a rate to watch, not a fatal error - the transcript is
                # still returned either way.
                "compressionRatioGuardFiredTotal": _counter_series(
                    self._metrics.compression_ratio_guard_fired_total
                ),
                "avgLogprobGuardFiredTotal": _counter_series(
                    self._metrics.avg_logprob_guard_fired_total
                ),
                "noSpeechProbGuardFiredTotal": _counter_series(
                    self._metrics.no_speech_prob_guard_fired_total
                ),
                "temperatureFallbackTotal": _counter_series(
                    self._metrics.temperature_fallback_total
                ),
                "repeatedSegmentDetectedTotal": _counter_series(
                    self._metrics.repeated_segment_detected_total
                ),
            },
            "histograms": {
                "asrSchedulingDelayMs": _histogram_series(
                    self._metrics.asr_scheduling_delay_ms
                ),
                "asrExecutionMs": _histogram_series(
                    self._metrics.asr_execution_ms
                ),
                "asrTotalMs": _histogram_series(self._metrics.asr_total_ms),
                # Wall-clock seconds per second of ingested audio. Crossing
                # 1.0 means the model cannot keep up with realtime on this
                # hardware, which is the capacity question the plan has been
                # approximating with a period-utilization proxy.
                "asrRtf": _histogram_series(self._metrics.asr_rtf),
            },
        }
