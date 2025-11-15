"""
Unit tests for LocalAgree
"""

from src.shared.utils.local_agree import LocalAgree, TranscriptionSegment
from src.transcription_provider_interface import TranscriptionSequence


def gen_segments(text: list[str], offset: float = 0):
    """
    Converts a list of text into a list of TranscriptionSegments
    with timestamps in 1 second intervals

    Args:
        text    - List of text to convert
        offset  - Amount to offset timestamps by

    Returns:
        List of TranscriptionSegments
    """
    segments: list[TranscriptionSegment] = []
    for start, word in enumerate(text):
        segments.append(
            TranscriptionSegment(
                text=word, start=offset + start, end=offset + start + 1
            )
        )
    return segments


def gen_sequence(text: list[str], offset: float = 0):
    """
    Converts a list of text into a TranscriptionSegment
    with timestamps in 1 second intervals

    Args:
        text    - List of text to convert
        offset  - Amount to offset timestamps by

    Returns:
        TranscriptionSequence
    """
    starts = [offset + i for i in range(len(text))]
    ends = [offset + i + 1 for i in range(len(text))]
    return TranscriptionSequence(text, starts, ends)


def test_single_append_in_progress_dim_2():
    """
    Test that appending a single sequence results in progress results
    """
    # Arrange
    ll = LocalAgree(2)
    text = ["Single", "sequence", "text"]

    # Act
    ll.append_transcription(gen_segments(text))

    # Assert
    assert ll.pop_finalized() is None
    assert ll.get_in_progress() == gen_sequence(text)


def test_multiple_diff_append_in_progress_dim_2():
    """
    Test that appending multiple different sequences results in progress results
    """
    # Arrange
    ll = LocalAgree(2)
    text0 = ["Single", "sequence", "test"]
    text1 = ["Single", "sequence", "text", "example"]

    # Act
    ll.append_transcription(gen_segments(text0))
    ll.append_transcription(gen_segments(text1))

    # Assert
    assert ll.pop_finalized() is None
    assert ll.get_in_progress() == gen_sequence(text1)


def test_multiple_same_append_no_end_in_progress_dim_2():
    """
    Test that appending multiple same sequences without sentence end
    results in progress results
    """
    # Arrange
    ll = LocalAgree(2)
    text0 = ["Single", "sequence", "text"]
    text1 = ["Single", "sequence", "text", "example"]

    # Act
    ll.append_transcription(gen_segments(text0))
    ll.append_transcription(gen_segments(text1))

    # Assert
    assert ll.pop_finalized() is None
    assert ll.get_in_progress() == gen_sequence(text1)


def test_multiple_same_append_no_end_commited_dim_2():
    """
    Test that appending multiple same sequences without sentence end
    results commited in progress results so a new commit with different
    text does not change commited in progress results
    """
    # Arrange
    ll = LocalAgree(2)
    text0 = ["Single", "sequence", "text"]
    text1 = ["Single", "sequence", "text", "example"]
    text2 = ["Changed", "sequence", "text", "example", "continued"]

    # Act
    ll.append_transcription(gen_segments(text0))
    ll.append_transcription(gen_segments(text1))
    ll.append_transcription(gen_segments(text2))

    # Assert
    assert ll.pop_finalized() is None
    assert ll.get_in_progress() == gen_sequence(text1 + ["continued"])


def test_multiple_diff_append_no_end_commited_dim_3():
    """
    Test that appending multiple differ sequences without sentence end
    results with higher local agree dim does not commit results
    """
    # Arrange
    ll = LocalAgree(3)
    text0 = ["Single", "sequence", "text"]
    text1 = ["Single", "sequence", "text", "example"]
    text2 = ["Changed", "sequence", "text", "example", "continued"]

    # Act
    ll.append_transcription(gen_segments(text0))
    ll.append_transcription(gen_segments(text1))
    ll.append_transcription(gen_segments(text2))

    # Assert
    assert ll.pop_finalized() is None
    assert ll.get_in_progress() == gen_sequence(text2)


def test_multiple_same_append_with_end_finalized_dim_2():
    """
    Test that appending a multiple same sequences with sentence end
    results in finalized results
    """
    # Arrange
    ll = LocalAgree(2)
    text0 = ["Single", "sequence", "text."]
    text1 = ["Single", "sequence", "text.", "Next", "sentence"]

    # Act
    ll.append_transcription(gen_segments(text0))
    ll.append_transcription(gen_segments(text1))

    # Assert
    assert ll.pop_finalized() == gen_sequence(text0)
    assert ll.get_in_progress() == gen_sequence(["Next", "sentence"], 3)


def test_force_finalized_in_progress():
    """
    Test that forcing finalization of text removes it from in progress results
    """
    # Arrange
    ll = LocalAgree(2)
    text0 = ["Single", "sequence", "text"]
    text1 = ["Single", "sequence", "text", "not", "finalized"]
    ll.append_transcription(gen_segments(text0))
    ll.append_transcription(gen_segments(text1))

    # Act
    forced = ll.force_finalized(3)

    # Assert
    assert forced == gen_sequence(text0)
    assert ll.pop_finalized() is None
    assert ll.get_in_progress() == gen_sequence(["not", "finalized"], 3)


def test_empty_forced_finalize():
    """
    Test that forcing finalization up to timestamp without text does nothing
    """
    # Arrange
    ll = LocalAgree(2)
    text0 = ["Single", "sequence", "text"]
    text1 = ["Single", "sequence", "text", "not", "finalized"]
    ll.append_transcription(gen_segments(text0, 5))
    ll.append_transcription(gen_segments(text1, 5))

    # Act
    forced = ll.force_finalized(3)

    # Assert
    assert forced is None
    assert ll.pop_finalized() is None
    assert ll.get_in_progress() == gen_sequence(text1, 5)
