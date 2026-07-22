"""
Detects Whisper hallucination loops via consecutive finalized-segment overlap
"""

# A conservative default: only used to demote confidence when the model is
# already showing hallucination symptoms (see job_counters.py), not to gate a
# clean transcript. Tune against real hallucination examples once they exist -
# the plan doc that scoped this flagged the threshold as under-validated.
DEFAULT_OVERLAP_THRESHOLD = 0.7


def _trigrams(text: str) -> set[str]:
    """
    Splits `text` into its set of word trigrams

    Texts shorter than three words have no trigram, so the whole text stands
    in for one - two identical short segments should still be able to match.

    Args:
        text - Text to split

    Returns:
        Set of trigrams, or a single-element set of the whole text if it has
        fewer than three words, or an empty set for empty text.
    """
    words = text.split()
    if len(words) < 3:
        return {" ".join(words)} if words else set()
    return {" ".join(words[i : i + 3]) for i in range(len(words) - 2)}


class RepeatedSegmentDetector:
    """
    Flags a finalized segment whose word trigrams substantially overlap the
    immediately preceding finalized segment

    Whisper hallucination loops tend to repeat text almost verbatim across
    consecutive segments rather than garble a single one, so comparing only
    to the immediately preceding segment (not a longer history) is enough to
    catch the common case cheaply.
    """

    def __init__(self, overlap_threshold: float = DEFAULT_OVERLAP_THRESHOLD):
        """
        Args:
            overlap_threshold - Trigram-Jaccard similarity above which two
                                  consecutive segments are considered a repeat
        """
        self._overlap_threshold = overlap_threshold
        self._previous_trigrams: set[str] = set()

    def check(self, text: str) -> bool:
        """
        Compares `text` against the previously checked segment and records it
        as the new previous segment for the next call

        Args:
            text - Newly finalized segment text

        Returns:
            True if `text`'s word trigrams overlap the previous segment's by
            more than `overlap_threshold` (Jaccard similarity)
        """
        trigrams = _trigrams(text)
        previous_trigrams = self._previous_trigrams
        self._previous_trigrams = trigrams

        if not trigrams or not previous_trigrams:
            return False

        overlap = len(trigrams & previous_trigrams) / len(
            trigrams | previous_trigrams
        )
        return overlap > self._overlap_threshold
