"""
Unit tests for the in-memory metric primitives
"""

import pytest
from freezegun import freeze_time

from src.webserver.shared.metrics import (
    DEFAULT_RETENTION_SEC,
    Counter,
    Histogram,
    parse_series_key,
    series_key,
)

# Any instant will do - the retention window is measured with time.monotonic(),
# which freezegun advances by whatever `tick` is given regardless of the wall
# clock it is anchored to. Sleeping for real is not an option at these
# durations, and the suite already drives time this way in the telemetry
# publisher tests.
NOW = "2026-07-21T12:00:00Z"

# Comfortably past the window, so a test never depends on whether the boundary
# is inclusive.
PAST_WINDOW_SEC = DEFAULT_RETENTION_SEC + 1


def test_series_key_is_order_independent():
    """
    Test label sets with the same pairs collapse to the same series
    """
    assert series_key({"a": "1", "b": "2"}) == series_key({"b": "2", "a": "1"})


def test_series_key_round_trips():
    """
    Test a serialized label set parses back to the same labels
    """
    # Arrange
    labels = {"provider_key": "whisper", "reason": "ValueError"}

    # Act
    parsed = parse_series_key(series_key(labels))

    # Assert
    assert parsed == labels


def test_empty_series_key_round_trips():
    """
    Test the unlabelled series survives serialization
    """
    assert series_key({}) == ""
    assert not parse_series_key("")


def test_counter_starts_at_zero():
    """
    Test reading a series that was never incremented gives 0 rather than raising
    """
    assert Counter("c", "help").get({"provider_key": "whisper"}) == 0


def test_counter_accumulates_per_series():
    """
    Test increments are kept separate per label set and summed by total()
    """
    # Arrange
    counter = Counter("c", "help")

    # Act
    counter.inc({"provider_key": "whisper"})
    counter.inc({"provider_key": "whisper"}, 2)
    counter.inc({"provider_key": "debug"})

    # Assert
    assert counter.get({"provider_key": "whisper"}) == 3
    assert counter.get({"provider_key": "debug"}) == 1
    assert counter.total() == 4


def test_counter_rejects_negative_increments():
    """
    Test counters cannot be decremented, since consumers difference them
    """
    with pytest.raises(ValueError):
        Counter("c", "help").inc({}, -1)


def test_counter_entries_expose_labels():
    """
    Test every series is exported with its parsed label set
    """
    # Arrange
    counter = Counter("c", "help")
    counter.inc({"provider_key": "whisper"}, 5)

    # Act
    entries = counter.entries()

    # Assert
    assert len(entries) == 1
    assert entries[0].labels == {"provider_key": "whisper"}
    assert entries[0].value == 5


def test_histogram_summary_is_none_without_observations():
    """
    Test an unobserved series reports no summary rather than zeros
    """
    assert Histogram("h", "help").summary() is None


def test_histogram_percentiles_use_nearest_rank():
    """
    Test percentiles are exact samples from the retained ring
    """
    # Arrange
    histogram = Histogram("h", "help")
    for value in range(1, 101):
        histogram.observe(value)

    # Act
    summary = histogram.summary()

    # Assert
    assert summary is not None
    assert summary.count == 100
    assert summary.sample_count == 100
    assert summary.minimum == 1
    assert summary.maximum == 100
    assert summary.mean == 50.5
    assert summary.p50 == 50
    assert summary.p95 == 95
    assert summary.p99 == 99


def test_histogram_retains_only_the_most_recent_samples():
    """
    Test the depth cap bounds memory independently of the age cap

    This is the `max_samples` bound, not the retention window: all six
    observations land microseconds apart and so well inside the window, leaving
    depth as the only thing that can drop any of them.
    Lifetime count and sum keep counting so they can still be differenced, but
    the percentiles and mean must reflect only what is retained - otherwise an
    early burst would drag a latency panel forever.
    """
    # Arrange
    histogram = Histogram("h", "help", max_samples=3)

    # Act
    for value in [100, 100, 100, 1, 2, 3]:
        histogram.observe(value)
    summary = histogram.summary()

    # Assert
    assert summary is not None
    assert summary.count == 6
    assert summary.sum == 306
    assert summary.sample_count == 3
    assert summary.maximum == 3
    assert summary.mean == 2


def test_histogram_separates_series_by_label():
    """
    Test observations under different labels do not pool together
    """
    # Arrange
    histogram = Histogram("h", "help")

    # Act
    histogram.observe(1, {"provider_key": "whisper"})
    histogram.observe(100, {"provider_key": "debug"})

    # Assert
    whisper = histogram.summary({"provider_key": "whisper"})
    debug = histogram.summary({"provider_key": "debug"})
    assert whisper is not None and whisper.maximum == 1
    assert debug is not None and debug.maximum == 100
    assert len(histogram.series_labels()) == 2


def test_histogram_rejects_a_zero_sample_cap():
    """
    Test a cap that would retain nothing is refused at construction
    """
    with pytest.raises(ValueError):
        Histogram("h", "help", max_samples=0)


def test_histogram_rejects_a_non_positive_retention_window():
    """
    Test a window that would retain nothing is refused at construction
    """
    with pytest.raises(ValueError):
        Histogram("h", "help", retention_sec=0)


def test_histogram_keeps_samples_inside_the_retention_window():
    """
    Test the window does not expire samples early

    The counterpart to the expiry tests below: a window that dropped samples
    ahead of time would make every percentile rest on a handful of jobs.
    """
    # Arrange
    histogram = Histogram("h", "help", retention_sec=10)

    # Act
    with freeze_time(NOW) as frozen:
        histogram.observe(1)
        frozen.tick(delta=9)
        histogram.observe(3)
        summary = histogram.summary()

    # Assert
    assert summary is not None
    assert summary.sample_count == 2
    assert summary.minimum == 1
    assert summary.maximum == 3


def test_histogram_expires_samples_older_than_the_retention_window():
    """
    Test an observation that has aged out no longer counts toward the window

    Without this the ring is bounded by count alone, so a single heavy session
    describes the metric until 4096 further observations displace it.
    """
    # Arrange
    histogram = Histogram("h", "help")

    # Act
    with freeze_time(NOW) as frozen:
        histogram.observe(100)
        frozen.tick(delta=PAST_WINDOW_SEC)
        histogram.observe(1)
        summary = histogram.summary()

    # Assert
    assert summary is not None
    assert summary.sample_count == 1
    assert summary.maximum == 1
    assert summary.mean == 1


def test_histogram_percentiles_reflect_only_the_current_window():
    """
    Test a past overload cannot hold the reported percentiles up

    This is the stuck-alert bug directly: the sidecar's T1 rule fires CRITICAL
    on p95 RTF at or above 1.0, so a p95 still carrying a finished heavy session
    keeps that alert firing at idle.
    """
    # Arrange
    histogram = Histogram("h", "help")

    # Act
    with freeze_time(NOW) as frozen:
        for _ in range(100):
            histogram.observe(2.0)
        overloaded = histogram.summary()

        frozen.tick(delta=PAST_WINDOW_SEC)
        for _ in range(100):
            histogram.observe(0.2)
        recovered = histogram.summary()

    # Assert
    assert overloaded is not None and overloaded.p95 == 2.0
    assert recovered is not None
    assert recovered.sample_count == 100
    assert recovered.p95 == 0.2
    assert recovered.maximum == 0.2


def test_histogram_lifetime_totals_survive_an_expiry():
    """
    Test count and sum stay lifetime cumulative across a window rollover

    The sidecar differences exactly these two fields to compute a mean over its
    own alert window. Windowing them, or resetting them when samples expire,
    would make that difference negative or nonsensical - its poller reads a
    decrease as a process restart and charges the whole new absolute value as
    one delta.
    """
    # Arrange
    histogram = Histogram("h", "help")

    # Act
    with freeze_time(NOW) as frozen:
        histogram.observe(10)
        histogram.observe(10)
        frozen.tick(delta=PAST_WINDOW_SEC)
        histogram.observe(1)
        summary = histogram.summary()

    # Assert - three observations totalling 21 for all time, one in the window.
    assert summary is not None
    assert summary.count == 3
    assert summary.sum == 21
    assert histogram.count() == 3
    assert summary.sample_count == 1
    assert summary.mean == 1


def test_histogram_reports_a_zeroed_window_once_every_sample_expires():
    """
    Test a fully expired series still reports itself, with an empty window

    Zero sample count is what tells the sidecar's poller its quantile gauges
    are stale and must be deleted, which is the half of the fix that actually
    clears the alert. The series must stay exported to say so - and the lifetime
    totals ride along on it, so the poller does not lose that interval's delta.
    """
    # Arrange
    histogram = Histogram("h", "help")

    # Act
    with freeze_time(NOW) as frozen:
        histogram.observe(100, {"provider_key": "whisper"})
        frozen.tick(delta=PAST_WINDOW_SEC)
        summary = histogram.summary({"provider_key": "whisper"})

    # Assert
    assert summary is not None
    assert summary.sample_count == 0
    assert summary.count == 1
    assert summary.sum == 100
    assert summary.minimum == 0
    assert summary.maximum == 0
    assert summary.mean == 0
    assert summary.p50 == 0
    assert summary.p95 == 0
    assert summary.p99 == 0
    # Still on the wire, otherwise the totals above would vanish with it.
    assert histogram.series_labels() == [{"provider_key": "whisper"}]


def test_histogram_summary_stays_none_for_a_series_never_observed():
    """
    Test an empty window and an absent series remain distinguishable

    A never-observed series has no totals worth reporting, so it is absent
    rather than zeroed - the distinction the expired-series case above relies on.
    """
    # Arrange
    histogram = Histogram("h", "help")

    # Act
    with freeze_time(NOW) as frozen:
        histogram.observe(1, {"provider_key": "whisper"})
        frozen.tick(delta=PAST_WINDOW_SEC)

        # Assert
        assert histogram.summary({"provider_key": "whisper"}) is not None
        assert histogram.summary({"provider_key": "debug"}) is None
