"""
Unit tests for RepeatedSegmentDetector, tested in isolation from the whisper
streaming job that consumes it.
"""

from src.shared.utils.repeated_segment_detector import RepeatedSegmentDetector


def test_first_segment_never_fires():
    """
    Nothing to compare the first segment against, so it can never be a repeat
    """
    detector = RepeatedSegmentDetector()

    assert (
        detector.check("the quick brown fox jumps over the lazy dog") is False
    )


def test_near_verbatim_repeat_fires():
    """
    A segment that repeats the previous one almost word-for-word fires

    This is the shape of a Whisper hallucination loop: the same phrase
    finalized again with only minor drift.
    """
    detector = RepeatedSegmentDetector()

    detector.check("the quick brown fox jumps over the lazy dog")
    fired = detector.check("the quick brown fox jumps over the lazy cat")

    assert fired is True


def test_unrelated_segments_do_not_fire():
    """
    Two segments about different content never fire, even back to back
    """
    detector = RepeatedSegmentDetector()

    detector.check("the weather today is sunny and warm")
    fired = detector.check("please remember to submit your timesheet")

    assert fired is False


def test_only_compares_against_the_immediately_preceding_segment():
    """
    A repeat of a segment two calls back (not the immediately preceding one)
    does not fire - hallucination loops repeat consecutively.
    """
    detector = RepeatedSegmentDetector()

    detector.check("the quick brown fox jumps over the lazy dog")
    detector.check("please remember to submit your timesheet")
    fired = detector.check("the quick brown fox jumps over the lazy dog")

    assert fired is False


def test_empty_text_never_fires_and_does_not_match_later_empty_text():
    """
    Empty finalized text (should not normally happen) is inert, not a
    guaranteed pair of matching empty sets.
    """
    detector = RepeatedSegmentDetector()

    detector.check("")
    fired = detector.check("")

    assert fired is False


def test_short_identical_segments_fire():
    """
    Segments under three words have no true trigram, but two identical short
    segments should still be caught rather than silently ignored.
    """
    detector = RepeatedSegmentDetector()

    detector.check("no")
    fired = detector.check("no")

    assert fired is True


def test_custom_threshold_is_respected():
    """
    A stricter threshold can suppress a match a default-configured detector
    would flag
    """
    lenient = RepeatedSegmentDetector(overlap_threshold=0.1)
    strict = RepeatedSegmentDetector(overlap_threshold=0.99)

    for detector in (lenient, strict):
        detector.check("the quick brown fox jumps over the lazy dog")

    lenient_fired = lenient.check("the quick brown fox jumps over the lazy cat")
    strict_fired = strict.check("the quick brown fox jumps over the lazy cat")

    assert lenient_fired is True
    assert strict_fired is False
