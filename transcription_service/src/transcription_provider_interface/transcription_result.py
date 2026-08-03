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
    `AudioStageReading`'s `vad` annotation a reverse import.
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


@dataclass(frozen=True)
class AudioStageReading:
    """
    One measurement point in a session's audio path

    Audio telemetry is a graph of measurement points rather than a single
    reading, because a single reading cannot answer the question operators
    actually have - *where* did the audio stop being good. A level that is fine
    at ingress and silent at the ASR's input is a pipeline fault; the same
    numbers reported once, unattributed, are indistinguishable from a dead
    microphone.

    **A stage declares what fed it, not where it sits.** `inputs` names the
    stage ids upstream of this one; the depth published alongside it is derived
    from that graph by the stream controller (see `audio_stage_graph`). Workers
    therefore need to know only their own immediate input - a VAD does not have
    to know what fed the thing that fed it - and a topology with several
    detectors, or one detector shared by several ASRs, describes itself without
    anything holding a central pipeline definition.

    Lives here rather than in a provider package for the same reason `VadStats`
    and `AudioChunkPayload` do: providers depend on this package and never the
    other way around, so this is the one place a shape crossing the
    worker/main-process boundary can be defined without a reverse import. Like
    them it holds plain Python scalars only, so it stays picklable across that
    boundary.
    """

    #: Stable id for this measurement point, unique within a session. See
    #: `audio_stages` for the ones the shipped providers use; the set is open.
    stage: str
    #: Operator-facing name. Carried on the reading rather than mapped in the
    #: webapp so a provider that invents a stage id also supplies its label,
    #: instead of surfacing as a raw identifier the UI has no string for.
    label: str
    #: Stage ids feeding this one. Empty means this is a source - audio enters
    #: the observed system here.
    inputs: tuple[str, ...]
    #: Level readout over this point's current metering window, or None when
    #: this point counts throughput but does not meter levels (a stage may
    #: legitimately measure only how much audio passed it).
    levels: AudioLevelStats | None
    #: Voice-activity statistics produced at this point, or None when this
    #: point runs no detector.
    vad: VadStats | None
    #: Seconds of audio that have passed this point since the session opened -
    #: cumulative and monotonic, so a reader can compare totals across an edge
    #: of the graph. None when this point cannot count it.
    #:
    #: Cumulative rather than per-window on purpose: a rate would have to agree
    #: with the reader's polling interval to be comparable between two stages,
    #: and the two stages do not share a clock.
    audio_seconds: float | None


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

    # Per-stage audio telemetry (B2.1/B2.2) measured inside the worker process
    # and carried out on the result the same way final_chunk_ids/
    # in_progress_chunk_ids are.
    #
    # Empty is a legitimate reading, not a gap: it means this provider measured
    # nothing this batch. The stream controller always contributes the ingress
    # stage on top of whatever a provider reports, so a session still publishes
    # audio telemetry when this is empty - which is the whole reason ingress
    # metering is not the provider's job. Providers add the stages only they can
    # see: what their decode produced, and what their detector passed on.
    audio_stages: tuple[AudioStageReading, ...] = ()
