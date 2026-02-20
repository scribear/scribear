"""
Defines TranscriptionResult data class
"""

from dataclasses import dataclass, field
from typing import Optional

from .transcription_sequence import TranscriptionSequence


@dataclass
class AudioChunkPayload:
    """
    Docstring for AudioChunkPayload
    """

    chunk_id: str
    received_time: float
    audio_bytes: bytes


@dataclass
class TranscriptionResult:
    """
    Returned after session processes an audio chunk.

    In Progress transcription segments replace previous In Progress transcription segments
    Final transcription segments append to previous Final transcription segments

    Both in_progress and final can be empty to indicate no results
    """

    in_progress: Optional["TranscriptionSequence"] = None
    final: Optional["TranscriptionSequence"] = None

    final_chunk_ids: list[str] = field(default_factory=list)
    final_latency_ms: Optional[float] = None

    in_progress_chunk_ids: list[str] = field(default_factory=list)
    in_progress_latency_ms: Optional[float] = None

    processing_stats: Optional[dict] = None
