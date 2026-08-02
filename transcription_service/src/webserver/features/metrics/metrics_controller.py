"""
Defines MetricsController that shapes the metrics registry into a JSON body
"""

from typing import Any

from src.shared.utils.worker_pool import CapacityEstimator
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

    A series that has been observed but whose retention window has since
    emptied is still emitted, carrying `sampleCount` 0, zeroed percentiles and
    its lifetime `count`/`sum`. That is the shape the sidecar's poller expects:
    zero sample count is how it learns the quantile gauges are stale and must be
    removed, while the lifetime totals it differences keep flowing. Omitting the
    series instead would also work for the gauges, but would silently cost the
    poller the totals for that interval. `None` is therefore only returned for a
    series that has never been observed at all, which `series_labels()` cannot
    produce - the guard below is kept as a contract check, not as a live path.

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
        capacity_estimator: CapacityEstimator,
    ):
        """
        Args:
            metrics_registry    - In-memory telemetry store
            provider_registry   - Owner of the worker pool and providers
            capacity_estimator  - Per-worker capacity estimator
                                    (archived-plans/2026-07-27-02-PLAN-AdmissionControl.md
                                    §3). Read here through snapshot() only; the
                                    enforcing caller is
                                    TranscriptionProviderRegistry, and this
                                    controller must stay side effect free so a
                                    poll can never move a decision.
        """
        self._metrics = metrics_registry
        self._providers = provider_registry
        self._capacity_estimator = capacity_estimator

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
            # The cadence each provider schedules its job at. Reported because
            # it was the one input the monitoring sidecar could not obtain from
            # anywhere and therefore had to be told, by hand, in a second file:
            # `job_period_ms` lives in this service's provider_config.json, so
            # the two statements agreed only by coincidence and a mismatch
            # silently misscaled the sidecar's period-utilization series. Each
            # value comes from the provider itself rather than from a
            # `getattr` on its config, because the config field is not
            # universal - `debug`'s period is a literal in debug_provider.py -
            # and a provider that cannot state one honestly is omitted rather
            # than guessed at.
            "providerJobPeriodMs": self._providers.provider_job_period_ms,
            # The inference device each provider's context runs on ("cuda" or
            # "cpu"), reported so the monitoring sidecar can select per-device
            # alert thresholds — a healthy GPU duty ratio (0.28-0.33) and a
            # healthy CPU duty ratio (0.17-0.47) are an order of magnitude
            # apart, and one global threshold cannot serve both. Same
            # reported-then-fallback shape as providerJobPeriodMs: the sidecar
            # prefers this, falls back to the GPU default for a service too
            # old to send it. A provider with no local device (debug,
            # lumen_granite) is omitted.
            "providerDevice": self._providers.provider_device,
            "workers": [
                {
                    **serialize_worker(snapshot),
                    # N* layered on top of the pool's own view of the worker,
                    # by a completely separate observer (PLAN-AdmissionControl
                    # .md §3) - not a WorkerSnapshot field, so this stays
                    # independent of what /providers/health reports. None
                    # means "not measured yet", never zero: the estimator is
                    # still in shadow mode and this is the first place its
                    # numbers become visible to an operator.
                    "estimatedCapacitySessions": (
                        self._capacity_estimator.snapshot(
                            snapshot.worker_id, snapshot.live_job_count
                        ).estimated_capacity_sessions
                    ),
                }
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
                "audioDroppedBufferFullTotal": _counter_series(
                    self._metrics.audio_dropped_buffer_full_total
                ),
                "audioDroppedBufferFullSecondsTotal": _counter_series(
                    self._metrics.audio_dropped_buffer_full_seconds_total
                ),
                "vadNoSpeechTotal": _counter_series(
                    self._metrics.vad_no_speech_total
                ),
                "noWordsTotal": _counter_series(self._metrics.no_words_total),
                # Periods the worker pool skipped because the previous pass
                # overran. The only counter here that reports a *scheduling*
                # loss rather than something a job measured, and the only
                # direct evidence of the failure that keeps every other number
                # green: RTF falls as periods are dropped, because each
                # surviving pass ingests more audio.
                "asrDroppedPeriodsTotal": _counter_series(
                    self._metrics.asr_dropped_periods_total
                ),
                # The one counter here that is incremented in the FastAPI
                # process rather than a worker: a frame that fails to decode
                # never reaches a job.
                "decodeDropsTotal": _counter_series(
                    self._metrics.decode_drops_total
                ),
                # The reconnect-loop fix: a binary frame that outran auth or
                # config is dropped rather than closing the socket 1008, which
                # a source's auto-reconnect would otherwise turn into a loop
                # that never delivers audio. Counted so a client stuck in that
                # pattern is still visible to an operator.
                "binaryDroppedBeforeAuthTotal": _counter_series(
                    self._metrics.binary_dropped_before_auth_total
                ),
                "binaryDroppedBeforeConfigTotal": _counter_series(
                    self._metrics.binary_dropped_before_config_total
                ),
                # Sessions the admission check turned away
                # (archived-plans/2026-07-27-02-PLAN-AdmissionControl.md §4).
                # Zero series is the healthy steady state, so this is one of the
                # few counters here whose *absence* of movement is the signal; it
                # is reported anyway because an operator asking "is anyone being
                # refused" must be able to get "no" as an answer rather than
                # silence.
                "sessionsRefusedCapacityTotal": _counter_series(
                    self._metrics.sessions_refused_capacity_total
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
