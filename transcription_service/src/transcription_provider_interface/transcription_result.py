"""
Defines TranscriptionResult data class
"""

from dataclasses import dataclass

from .transcription_sequence import TranscriptionSequence


@dataclass
class TranscriptionResult:
    """
    Returned after session processes an audio chunk.

    In Progress transcription segments replace previous In Progress transcription segments
    Final transcription segments append to previous Final transcription segments

    Both in_progress and final can be empty to indicate no results
    """

    in_progress: TranscriptionSequence | None = None
    final: TranscriptionSequence | None = None
