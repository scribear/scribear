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

from dataclasses import dataclass
from math import ceil, nan
from typing import Mapping

# Retained observations per histogram series. Percentiles need raw samples, and
# retention is what bounds the cost: memory is O(series * this), never O(uptime)
# or O(sessions ever seen).
DEFAULT_MAX_SAMPLES = 4096

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
    be differenced across polls. Everything else describes only the retained
    ring, i.e. recent behaviour - which is the point of percentiles, and why
    `mean` is computed from the ring rather than from the lifetime sum.
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
    Histogram that retains a bounded ring of raw observations so exact
    percentiles can be reported

    Bucket counts alone (the Prometheus model) would give only interpolated
    quantiles, and the dashboard's latency panels are specified in terms of
    p50/p95/p99. Retaining raw samples is affordable because the cap is
    per-series and small; it is NOT a general-purpose design, and it is why
    series must be labelled by provider rather than by session.
    """

    def __init__(
        self, name: str, help_text: str, max_samples: int = DEFAULT_MAX_SAMPLES
    ):
        """
        Args:
            name        - Metric name
            help_text   - Human readable description of what is observed
            max_samples - Retained observations per series
        """
        if max_samples <= 0:
            raise ValueError("max_samples must be at least 1")

        self.name = name
        self.help_text = help_text
        self._max_samples = max_samples

        self._samples: dict[str, list[float]] = {}
        self._counts: dict[str, int] = {}
        self._sums: dict[str, float] = {}

    def observe(self, value: float, labels: Labels | None = None) -> None:
        """
        Records a single observation

        Args:
            value   - Observed value
            labels  - Label set identifying the series
        """
        key = series_key(labels or {})

        samples = self._samples.setdefault(key, [])
        samples.append(value)
        # Ring behaviour: drop the oldest observation once the cap is hit, so
        # percentiles describe recent behaviour rather than all of history.
        if len(samples) > self._max_samples:
            del samples[0 : len(samples) - self._max_samples]

        self._counts[key] = self._counts.get(key, 0) + 1
        self._sums[key] = self._sums.get(key, 0) + value

    def summary(self, labels: Labels | None = None) -> HistogramSummary | None:
        """
        Gets summary statistics for a series

        Args:
            labels  - Label set identifying the series

        Returns:
            HistogramSummary, or None if the series has no observations
        """
        key = series_key(labels or {})
        samples = self._samples.get(key)
        if not samples:
            return None

        ordered = sorted(samples)
        return HistogramSummary(
            count=self._counts.get(key, 0),
            sum=self._sums.get(key, 0),
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
        Gets the label set of every series currently held, for export
        """
        return [parse_series_key(key) for key in self._samples]

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
