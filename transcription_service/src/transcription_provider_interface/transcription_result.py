"""
Defines TranscriptionResult data class
"""

from dataclasses import dataclass, field

from src.shared.utils.audio_meter import AudioLevelStats

from .transcription_sequence import TranscriptionSequence


@dataclass
class AudioChunkPayload:
    """
    A single source audio chunk paired with its correlation id. Providers that
    support latency tracking carry this (instead of raw bytes) through their
    worker-pool job so the chunk id can be echoed back with the transcript it
    contributes to.
    """

    chunk_id: str
    audio_bytes: bytes


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

    # Ids of the source audio chunks that contributed to each transcript, so
    # the node server can correlate a transcript back to the audio frame it
    # came from and measure latency. Empty when the provider does not track
    # chunk ids.
    final_chunk_ids: list[str] = field(default_factory=list)
    in_progress_chunk_ids: list[str] = field(default_factory=list)

    # Audio-level meter readout (B2.1) - Whisper-provider-specific, computed
    # inside the worker process and carried out on the result the same way
    # final_chunk_ids/in_progress_chunk_ids are. None for providers that
    # don't meter audio (debug, lumen_granite) and for Whisper itself until
    # its meter's rolling window has received its first samples.
    audio_stats: AudioLevelStats | None = None
