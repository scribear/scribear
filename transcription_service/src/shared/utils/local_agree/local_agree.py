"""
Defines LocalAgree for stabilizing transcriptions
"""

from collections import deque
from dataclasses import dataclass

from src.transcription_provider_interface import TranscriptionSequence


@dataclass
class TranscriptionSegment:
    """
    Represents a smallest segment of text with start and end times
    """

    text: str
    start: float
    end: float


SENTENCE_ENDS = (".", "?", "!")
SENTENCE_ENDS_WHITELIST = "..."


def _is_sentence_end(segment: TranscriptionSegment):
    """
    Determine if a segment is the last segment of a sentence
    """
    if not segment.text.endswith(SENTENCE_ENDS):
        return False
    if segment.text.endswith(SENTENCE_ENDS_WHITELIST):
        return False
    return True


def _segments_to_sequence(segments: list[TranscriptionSegment]):
    """
    Converts a list of TranscriptionSegment to a TranscriptionSequence

    Args:
        segments    - List of segments to convert to sequence

    Returns:
        TranscriptionSequence containing text, starts, and ends of given segments
    """
    text: list[str] = []
    starts: list[float] = []
    ends: list[float] = []
    for s in segments:
        text.append(s.text)
        starts.append(s.start)
        ends.append(s.end)
    return TranscriptionSequence(text, starts, ends)


class LocalAgree:
    """
    Implements the "Local Agreement" algorithm to described in (Liu et al., 2020)
        stabilize real-time transcription.

    This algorithm compares the latest transcription with the previous ones to find
        a stable prefix that can be considered "final".
    A segment is commited only if it has remained unchanged for a certain
        number of transcription steps, defined by `local_agree_dim`.
    A finalized sequence is a sequence of commited segments that forms a full sentence.

    @misc{liu2020lowlatencysequencetosequencespeechrecognition,
      title={Low-Latency Sequence-to-Sequence Speech Recognition
                and Translation by Partial Hypothesis Selection},
      author={Danni Liu and Gerasimos Spanakis and Jan Niehues},
      year={2020},
      eprint={2005.11185},
      archivePrefix={arXiv},
      primaryClass={cs.CL},
      url={https://arxiv.org/abs/2005.11185},
    }
    """

    def __init__(self, local_agree_dim: int):
        """
        Initializes the LocalAgree processor.

        Args:
            local_agree_dim - Transcription steps needed to consider segment stable
        """
        if local_agree_dim < 1:
            raise ValueError("Local Agree dimension must be at least 1")
        self._local_agree_dim = local_agree_dim
        self._commited_segments: deque[TranscriptionSegment] = deque()
        self._in_progress_segments: deque[deque[TranscriptionSegment]] = deque()
        self._commited_time = 0.0

    def _next_commit_segment(self):
        """
        Get the next segment that can be commited
        A segment can be commited if all previous transcriptions agree on text

        Returns:
            TranscriptionSegment that can be commited
        """
        for dim in range(self._local_agree_dim):
            if (len(self._in_progress_segments[dim]) == 0) or (
                self._in_progress_segments[dim][0].text
                != self._in_progress_segments[-1][0].text
            ):
                return None
        return self._in_progress_segments[-1][0]

    def get_in_progress(self):
        """
        Gets all currently non-finalized transcriptions

        Returns:
            TranscriptionSequence containing in progress transcriptions
        """
        in_progress_segments = list(self._commited_segments)
        in_progress_segments += list(self._in_progress_segments[-1])
        if len(in_progress_segments) == 0:
            return None
        return _segments_to_sequence(in_progress_segments)

    def pop_finalized(self):
        """
        Get and remove all finalized transcriptions

        Returns:
            TranscriptionSequence containing finalized transcriptions
        """
        # Find all finalizable transcriptions
        finalized: list[TranscriptionSegment] = []
        potential_finalized: list[TranscriptionSegment] = []
        for segment in self._commited_segments:
            potential_finalized.append(segment)

            if _is_sentence_end(segment):
                finalized.extend(potential_finalized)
                potential_finalized = []

        # Purge finalized segments from commit list
        for segment in finalized:
            self._commited_segments.popleft()

        if len(finalized) == 0:
            return None
        return _segments_to_sequence(finalized)

    def force_finalized(self, end_time: float):
        """
        Force segments prior to given end_time to be finalized and removed

        Args:
            end_time    - Time to force finalization of segments up to

        Returns:
            TranscriptionSequence containing forced finalized transcriptions
        """
        segments: list[TranscriptionSegment] = []

        # Force finalization of commited segments
        while len(self._commited_segments) > 0:
            if self._commited_segments[0].start >= end_time:
                break
            segment = self._commited_segments.popleft()
            segments.append(segment)

        if len(self._in_progress_segments) == 0:
            if len(segments) == 0:
                return None
            return _segments_to_sequence(segments)

        # Force finialization of the most recent in progress segments (if needed)
        while len(self._in_progress_segments[-1]) > 0:
            if self._in_progress_segments[-1][0].start >= end_time:
                break

            segment = self._in_progress_segments[-1].popleft()
            segments.append(segment)

        # Remove in progress segments in earlier than end_time transcription history
        for in_progress_segments in self._in_progress_segments:
            while len(in_progress_segments) > 0:
                if in_progress_segments[0].start >= end_time:
                    break

                in_progress_segments.popleft()

        if len(segments) == 0:
            return None
        return _segments_to_sequence(segments)

    def append_transcription(self, segments: list[TranscriptionSegment]):
        """
        Appends latest transcription to transcription history and compute commited segments

        Args:
            segments    - Transcription segments of transcription to append
        """
        # Remove all segments that occur before already committed timestamp
        new_segments = deque(segments)
        while len(new_segments) > 0:
            if new_segments[0].start < self._commited_time:
                new_segments.popleft()
            else:
                break

        # Add to segment history and only keep last local_agree_dim histories
        self._in_progress_segments.append(new_segments)
        if len(self._in_progress_segments) > self._local_agree_dim:
            self._in_progress_segments.popleft()

        # Can't commit any segments if not enough dimensions yet
        if len(self._in_progress_segments) < self._local_agree_dim:
            return

        # Get all segments that can be commited and append to commited_segments
        while (segment := self._next_commit_segment()) is not None:
            # Remove from in_progress segments
            for dim in range(self._local_agree_dim):
                self._in_progress_segments[dim].popleft()
            self._commited_segments.append(segment)
            self._commited_time = segment.end
