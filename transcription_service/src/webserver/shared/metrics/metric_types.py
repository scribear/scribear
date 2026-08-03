"""
Minimal in-memory metric primitives for the transcription service.

Deliberately hand-rolled rather than pulling in `prometheus_client`: this
service exposes JSON only (PLAN-B1.2 §2 D5 - the monitoring sidecar owns the
Prometheus registry and the metric naming), so a scrape-format library would
add a dependency and buy nothing. The surface here is small enough that owning
it is cheaper than adapting a library.

Nothing is persisted. Restarting the service zeroes every metric; that is an
accepted trade, matching the sidecar's own in-memory store.
"""

import time
from collections import deque
from dataclasses import dataclass
from math import ceil, nan
from typing import Mapping

# Retained observations per histogram series. Percentiles need raw samples, and
# retention is what bounds the cost: memory is O(series * this), never O(uptime)
# or O(sessions ever seen).
DEFAULT_MAX_SAMPLES = 4096

# Age at which a retained observation stops counting toward the percentiles.
#
# A count cap on its own is not a window. A series that stops being observed
# keeps whatever it last held for as long as the process lives, so `p95`
# describes the busiest minute of a session that ended hours ago. The monitoring
# sidecar turns that into a stuck alert: its poller republishes each histogram's
# p50/p95/p99/max as gauges and only removes a series once `sampleCount` reaches
# zero, and the T1 saturation rule fires CRITICAL while the p95 RTF gauge is at
# or above 1.0. Under a count-only cap `sampleCount` never reaches zero, so one
# heavy session left that CRITICAL firing at idle until either a restart or 4096
# further, lighter observations pushed the old ones out - roughly 34 minutes of
# uninterrupted streaming per provider at a 500 ms job period.
#
# 120 s, deliberately equal to the sidecar's own `ALERT_RATE_WINDOW_SEC`
# default. The two T1 rules then talk about the same span of time: the
# mean-RTF early warning averages differenced totals over 120 s, and the p95
# CRITICAL is now the tail of that same 120 s. An operator reading both is not
# shown two claims about two different pasts.
#
# The bounds that pin the number down, rather than it being a tidy round one:
#   * Floor - the sidecar polls every `TRANSCRIPTION_METRICS_INTERVAL_SEC`
#     (10 s by default), so the window has to span several polls or a series
#     under continuous load would intermittently read as empty and flap its
#     gauges in and out of existence. 120 s is 12 polls.
#   * Ceiling - the entire point is that a saturation alert clears when the load
#     that caused it stops. Two minutes of lag is an operator briefly seeing a
#     stale banner; ten minutes is back to not trusting the banner.
#   * Depth - at the CUDA config's 500 ms job period this holds ~240
#     observations per provider, so p95 rests on ~12 samples and p99 on ~2.
#     The CPU template's 5000 ms period holds only ~24, where p95 is
#     effectively the window maximum and will be spikier than it used to be.
#     That is the one regression this trade accepts; a deployment running
#     periods that long should raise the window rather than re-tune the alert,
#     which is why it is a constructor argument and not a literal.
#
# Rejected: expiring by *poll* instead of by time (reset the ring whenever
# /metrics/status is read). It needs no clock, but it makes the exported window
# depend on who is scraping and how often, and two consumers would each see a
# fraction of the samples.
DEFAULT_RETENTION_SEC = 120.0

# One retained observation: when it was recorded, and what was recorded. The
# timestamp is `time.monotonic` rather than wall clock because this is an
# elapsed-time window, and an NTP step must not retire a window's worth of
# samples at once (or refuse to retire any) - the same reasoning, and the same
# clock, as the Lumen provider's probe cache.
TimedSample = tuple[float, float]

Labels = Mapping[str, str]


def series_key(labels: Labels) -> str:
    """
    Serializes a label set into a stable series key

    Keys are sorted so that {a, b} and {b, a} collapse to the same series.

    Args:
        labels  - Label set to serialize

    Returns:
        Stable string key for the series
    """
    if not labels:
        return ""
    return ",".join(f"{k}={labels[k]}" for k in sorted(labels))


def parse_series_key(key: str) -> dict[str, str]:
    """
    Parses a series key produced by series_key back into labels

    Args:
        key     - Series key to parse

    Returns:
        Label dictionary; empty for the empty key
    """
    if key == "":
        return {}
    labels: dict[str, str] = {}
    for part in key.split(","):
        name, separator, value = part.partition("=")
        if separator:
            labels[name] = value
    return labels


@dataclass(frozen=True)
class Series:
    """
    A single labelled series and its current value
    """

    labels: dict[str, str]
    value: float


class Counter:
    """
    Monotonic counter with labels

    Counters are never reset and never decremented: consumers difference
    successive reads to obtain rates, and compare the process uid first so a
    restart is not read as a large negative rate.
    """

    def __init__(self, name: str, help_text: str):
        """
        Args:
            name        - Metric name
            help_text   - Human readable description of what is counted
        """
        self.name = name
        self.help_text = help_text
        self._values: dict[str, float] = {}

    def inc(self, labels: Labels | None = None, value: float = 1) -> None:
        """
        Increments a series

        Args:
            labels  - Label set identifying the series
            value   - Amount to add, must not be negative
        """
        if value < 0:
            raise ValueError("Counters must not decrease")
        key = series_key(labels or {})
        self._values[key] = self._values.get(key, 0) + value

    def get(self, labels: Labels | None = None) -> float:
        """
        Gets the current value of a series, 0 if it has never been incremented

        Args:
            labels  - Label set identifying the series
        """
        return self._values.get(series_key(labels or {}), 0)

    def total(self) -> float:
        """
        Gets the sum across every series, ignoring labels
        """
        return sum(self._values.values())

    def entries(self) -> list[Series]:
        """
        Gets every series currently held, for export
        """
        return [
            Series(parse_series_key(key), value)
            for key, value in self._values.items()
        ]


@dataclass(frozen=True)
class HistogramSummary:
    """
    Summary statistics derived from a histogram series

    `count` and `sum` are lifetime totals, so they behave like counters and can
    be differenced across polls. They are NOT windowed and are never reset when
    samples expire: the sidecar's mean-RTF rule differences exactly these two to
    get a windowed mean, and a total that fell would be read as a restart and
    charged as one enormous delta.

    Everything else describes only the samples still inside the retention
    window, i.e. recent behaviour - which is the point of percentiles, and why
    `mean` is computed from the window rather than from the lifetime sum.
    `sample_count` is therefore "observations currently retained", not a
    lifetime count; `count` is the lifetime one.

    A series whose window has emptied reports `sample_count` 0 with every
    windowed field 0.0 and its lifetime totals untouched. Zero rather than nan
    because the sidecar's schema types these as numbers and Python's `json`
    would emit a bare `NaN` token that a strict parser rejects, failing the
    whole poll; consumers are expected to gate on `sample_count`, which is what
    the poller does.
    """

    count: int
    sum: float
    sample_count: int
    minimum: float
    maximum: float
    mean: float
    p50: float
    p95: float
    p99: float


class Histogram:
    """
    Histogram that retains a bounded, time-limited ring of raw observations so
    exact percentiles over recent behaviour can be reported

    Bucket counts alone (the Prometheus model) would give only interpolated
    quantiles, and the dashboard's latency panels are specified in terms of
    p50/p95/p99. Retaining raw samples is affordable because the cap is
    per-series and small; it is NOT a general-purpose design, and it is why
    series must be labelled by provider rather than by session.

    The ring is bounded twice, by age (`retention_sec`) and by depth
    (`max_samples`), and the two answer different questions. Age is what makes a
    reported percentile mean "recently" and is what lets it go away when the
    load does - see DEFAULT_RETENTION_SEC for the alert this exists to unstick.
    Depth is what stops a provider fast enough to complete tens of thousands of
    jobs inside one window from making a single series unboundedly large.
    """

    def __init__(
        self,
        name: str,
        help_text: str,
        max_samples: int = DEFAULT_MAX_SAMPLES,
        retention_sec: float = DEFAULT_RETENTION_SEC,
    ):
        """
        Args:
            name            - Metric name
            help_text       - Human readable description of what is observed
            max_samples     - Retained observations per series
            retention_sec   - Age at which a retained observation is dropped
        """
        if max_samples <= 0:
            raise ValueError("max_samples must be at least 1")
        if retention_sec <= 0:
            raise ValueError("retention_sec must be greater than 0")

        self.name = name
        self.help_text = help_text
        self._max_samples = max_samples
        self._retention_sec = retention_sec

        self._samples: dict[str, deque[TimedSample]] = {}
        self._counts: dict[str, int] = {}
        self._sums: dict[str, float] = {}

    def observe(self, value: float, labels: Labels | None = None) -> None:
        """
        Records a single observation

        Called once per job completion, so it must stay cheap: this is O(1)
        amortised. The depth cap costs nothing (deque's own `maxlen` evicts on
        append), and expiry is amortised O(1) - see `_expire`.

        Args:
            value   - Observed value
            labels  - Label set identifying the series
        """
        key = series_key(labels or {})
        now = time.monotonic()

        samples = self._samples.get(key)
        if samples is None:
            # `maxlen` is the depth cap: appending to a full deque drops the
            # oldest in O(1), which the previous list-plus-slice-delete did in
            # O(max_samples) memmove on every observation past the cap.
            samples = deque(maxlen=self._max_samples)
            self._samples[key] = samples

        samples.append((now, value))
        self._expire(samples, now)

        # Lifetime, and deliberately outside the window: consumers difference
        # these to get rates and windowed means, so they must only ever grow.
        self._counts[key] = self._counts.get(key, 0) + 1
        self._sums[key] = self._sums.get(key, 0) + value

    def _expire(self, samples: deque[TimedSample], now: float) -> None:
        """
        Drops observations that have aged out of the retention window

        Amortised O(1) per observation: samples are appended in time order, so
        the expired ones are always a prefix, and each sample is popped exactly
        once in its life. Rejected alternative - filtering by timestamp at read
        time instead, which is O(window) on every poll and, worse, leaves an
        idle series holding its samples forever, since the only thing that
        would free them is the next `observe()` that never comes.

        Args:
            samples - Series ring, oldest first
            now     - Current monotonic reading
        """
        cutoff = now - self._retention_sec
        while samples and samples[0][0] <= cutoff:
            samples.popleft()

    def summary(self, labels: Labels | None = None) -> HistogramSummary | None:
        """
        Gets summary statistics for a series

        Expires aged-out samples before reading, which is the half of the fix
        that matters for an *idle* series: nothing else will ever run for it.
        Mutating on a read path is safe without a lock because both mutators run
        on the event loop thread: `observe()` is reached from
        `WorkerProcessManager._handle_loop_result`, which exists specifically to
        move worker results onto that thread, and this from the `async`
        /metrics/status route. A lock would have to be added along with the first
        caller that is not on it.

        Args:
            labels  - Label set identifying the series

        Returns:
            None if the series has never been observed. Otherwise a
            HistogramSummary; a series that was observed but whose window has
            since emptied reports `sample_count` 0 with zeroed window fields and
            its lifetime `count`/`sum` intact. It stays on the wire rather than
            vanishing precisely so those totals keep being reported - the
            sidecar's poller folds them into counters without gating on
            `sample_count`, and a missing series would cost it that poll's delta.
        """
        key = series_key(labels or {})
        samples = self._samples.get(key)
        if samples is None:
            return None

        self._expire(samples, time.monotonic())
        count = self._counts.get(key, 0)
        total = self._sums.get(key, 0)
        if not samples:
            return HistogramSummary(
                count=count,
                sum=total,
                sample_count=0,
                minimum=0.0,
                maximum=0.0,
                mean=0.0,
                p50=0.0,
                p95=0.0,
                p99=0.0,
            )

        ordered = sorted(value for _, value in samples)
        return HistogramSummary(
            count=count,
            sum=total,
            sample_count=len(ordered),
            minimum=ordered[0],
            maximum=ordered[-1],
            mean=sum(ordered) / len(ordered),
            p50=_percentile(ordered, 0.5),
            p95=_percentile(ordered, 0.95),
            p99=_percentile(ordered, 0.99),
        )

    def series_labels(self) -> list[dict[str, str]]:
        """
        Gets the label set of every series ever observed, for export

        Keyed off the lifetime counts rather than the sample rings, so that a
        series whose window has emptied is still exported. Dropping it would
        take its lifetime `count`/`sum` off the wire too, and a consumer
        differencing those absolute totals would lose every delta accumulated
        up to the moment the load stopped.
        """
        return [parse_series_key(key) for key in self._counts]

    def count(self, labels: Labels | None = None) -> int:
        """
        Gets the lifetime number of observations for a series

        Args:
            labels  - Label set identifying the series
        """
        return self._counts.get(series_key(labels or {}), 0)


def _percentile(ordered: list[float], quantile: float) -> float:
    """
    Nearest-rank percentile over a pre-sorted list

    Args:
        ordered     - Ascending list of samples
        quantile    - Quantile from 0-1

    Returns:
        Sample at the nearest rank, or nan for an empty list
    """
    if not ordered:
        return nan
    rank = ceil(quantile * len(ordered))
    index = min(max(rank - 1, 0), len(ordered) - 1)
    return ordered[index]
