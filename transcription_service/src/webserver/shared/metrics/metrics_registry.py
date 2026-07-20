"""
Defines MetricsRegistry, the in-memory store of transcription-service telemetry
"""

import uuid
from datetime import datetime, timezone

from src.shared.utils.worker_pool import JobExecutionObservation

from .metric_types import DEFAULT_MAX_SAMPLES, Counter, Histogram

NS_PER_MS = 1_000_000

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
