"""
Defines TranscriptionResult data class
"""

from dataclasses import dataclass, field

from src.shared.utils.audio_meter import AudioLevelStats

from .transcription_sequence import TranscriptionSequence


@dataclass(frozen=True)
class VadStats:
    """
    Per-batch voice-activity-detection statistics (B2.2), derived from the
    same speech/silence ranges `_detect_speech_ranges` already computes to
    decide what to hand Whisper - no separate detection pass.

    Lives here (interface layer) rather than alongside
    `WhisperStreamingProviderJob`, even though it has no reusable stateful
    engine behind it the way `AudioMeter` does: providers already depend on
    this package (`transcription_provider_interface`), never the other way
    around, so defining it in the provider package would make
    `TranscriptionResult`'s `vad_stats` annotation a reverse import.
    `AudioChunkPayload` sits next to it for the same reason - a plain shape
    with no behavior of its own, defined where every crosser of the
    worker/main-process boundary can reach it without an import cycle.

    Transient, not persistent: unlike `AudioMeter`, there is no long-lived
    object behind this - it is recomputed from scratch every
    `_transcribe_audio` call and carried out on the next `TranscriptionResult`.
    """

    #: self._enable_vad - always meaningful, even when every other field
    #: below is None (VAD off) or reflects a real all-silence buffer (VAD on,
    #: no speech found).
    vad_enabled: bool
    #: Fraction (0..1) of the buffer VAD marked as speech. None when VAD is
    #: off (the "ranges" it would be computed from is a fake full-buffer
    #: placeholder, not a measurement).
    speech_active_ratio: float | None
    #: Number of speech ranges VAD found in this buffer. None when VAD is off.
    segment_count: int | None
    #: Mean speech-segment duration, in seconds. None when VAD is off, or
    #: when VAD found no segments to average (undefined, not zero).
    mean_segment_duration_sec: float | None
    #: speech_active_ratio / (1 - speech_active_ratio). None when VAD is off,
    #: or when speech_active_ratio >= 1.0 (divide-by-zero guard at
    #: "all speech, no pause").
    speech_to_pause_ratio: float | None
    #: Mean in-range RMS (dBFS) minus mean out-of-range RMS (dBFS). None when
    #: VAD is off, or when one side of the comparison has no samples (the
    #: buffer read as 0% or 100% speech).
    snr_db: float | None


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

    # VAD statistics (B2.2) - same Whisper-provider-specific treatment as
    # audio_stats, but transient rather than backed by a persistent meter:
    # recomputed each _transcribe_audio call. None for providers that don't
    # run VAD (debug, lumen_granite), for Whisper when vad_detector is off,
    # and for the batch in which _transcribe_audio's buffer was empty (no VAD
    # ran at all that call).
    vad_stats: VadStats | None = None
