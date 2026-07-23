"""
Unit tests for the in-memory metric primitives
"""

import pytest

from src.webserver.shared.metrics import (
    Counter,
    Histogram,
    parse_series_key,
    series_key,
)


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
    Test the ring caps memory and describes recent behaviour

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
