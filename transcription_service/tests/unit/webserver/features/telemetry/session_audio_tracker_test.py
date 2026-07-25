"""
Unit tests for SessionAudioTracker
"""

import io
from typing import Any
from unittest.mock import MagicMock

import numpy as np
import numpy.typing as npt
import soundfile as sf

from src.shared.logger import ContextLogger
from src.transcription_provider_interface import (
    STAGE_ASR_INPUT,
    STAGE_INGRESS,
    STAGE_VAD,
    AudioStageReading,
    VadStats,
)
from src.webserver.features.telemetry import INGRESS_LABEL, SessionAudioTracker

# 100 ms, matching the kiosk's AUDIO_CHUNK_MS - the duty cycle §12.9 measured
# the ingress metering cost against.
CHUNK_SEC = 0.1


def _wav(
    samples: npt.NDArray[Any], sample_rate: int, subtype: str = "FLOAT"
) -> bytes:
    """Wraps samples in a WAV container, the way a real chunk arrives."""
    buffer = io.BytesIO()
    sf.write(buffer, samples, sample_rate, format="WAV", subtype=subtype)
    return buffer.getvalue()


def _tone(sample_rate: int, amplitude: float = 0.5, seconds: float = CHUNK_SEC):
    """A constant-amplitude mono signal, so its RMS is exactly `amplitude`."""
    return np.full(int(sample_rate * seconds), amplitude, dtype=np.float32)


def _tracker(silence_threshold: float = 0.01):
    logger = MagicMock(spec=ContextLogger)
    return SessionAudioTracker(logger, silence_threshold), logger


def _reading(stage: str, *inputs: str, audio_seconds: float | None = None):
    """A provider-shaped reading with no levels of its own."""
    return AudioStageReading(
        stage=stage,
        label=stage,
        inputs=inputs,
        levels=None,
        vad=None,
        audio_seconds=audio_seconds,
    )


def test_a_chunk_that_does_not_decode_is_not_metered_and_does_not_raise():
    """
    This runs on the websocket's own codepath, once per inbound chunk. A
    container the meter cannot read still reaches the provider, whose decoder
    validates it properly - so a raise here would drop a session's audio to
    report on a dashboard.
    """
    # Arrange
    tracker, _ = _tracker()

    # Act
    metered = tracker.meter_chunk(b"not audio at all")

    # Assert - and no ingress stage, because nothing was measured.
    assert metered is False
    assert not tracker.resolved_stages()


def test_the_meter_takes_its_sample_rate_from_the_chunks_own_header():
    """
    The webserver never sees provider config, so the rate is only knowable
    from the chunk. A meter built on an assumed rate would report a window and
    a cumulative total scaled by the ratio of the two rates - a 44.1 kHz
    source read as 16 kHz would claim nearly three times the audio it sent.
    """
    # Arrange
    tracker, _ = _tracker()

    # Act
    assert tracker.meter_chunk(_wav(_tone(44_100), 44_100)) is True

    # Assert
    (ingress,) = tracker.resolved_stages()
    assert ingress.reading.audio_seconds == CHUNK_SEC


def test_ingress_seconds_accumulate_across_chunks():
    """
    §12.2 requires a cumulative total, not a rate: the reader subtracts one
    stage's total from its neighbour's, and the two stages do not share a
    clock, so a per-window number could not be compared across the edge.
    """
    # Arrange
    tracker, _ = _tracker()

    # Act
    for _ in range(3):
        tracker.meter_chunk(_wav(_tone(16_000), 16_000))

    # Assert
    (ingress,) = tracker.resolved_stages()
    assert ingress.reading.audio_seconds == CHUNK_SEC * 3


def test_a_multi_channel_chunk_counts_frames_not_samples():
    """
    Seconds must come from the frame count, not the sample count: charging a
    stereo chunk twice over would make ingress report more audio than the
    session ever sent, and the reader would render the surplus as negative
    signal loss on the edge below it.
    """
    # Arrange
    tracker, _ = _tracker()
    frames = int(16_000 * CHUNK_SEC)
    stereo = np.full((frames, 2), 0.5, dtype=np.float32)

    # Act
    assert tracker.meter_chunk(_wav(stereo, 16_000)) is True

    # Assert
    (ingress,) = tracker.resolved_stages()
    assert ingress.reading.audio_seconds == CHUNK_SEC


def test_the_configured_silence_threshold_decides_what_reads_as_silent():
    """
    AUDIO_SILENCE_THRESHOLD exists because the number is room-dependent
    (§12.7) and the ingress meter has no provider config to read it from. A
    threshold that did not reach the meter would leave the env var inert while
    appearing to be wired.
    """
    # Arrange - RMS 0.005: under the shipped 0.01 floor, over a 0.001 one.
    quiet = _wav(_tone(16_000, amplitude=0.005), 16_000)
    default_tracker, _ = _tracker()
    lowered_tracker, _ = _tracker(silence_threshold=0.001)

    # Act
    default_tracker.meter_chunk(quiet)
    lowered_tracker.meter_chunk(quiet)

    # Assert
    (default_ingress,) = default_tracker.resolved_stages()
    (lowered_ingress,) = lowered_tracker.resolved_stages()
    assert default_ingress.reading.levels is not None
    assert lowered_ingress.reading.levels is not None
    assert default_ingress.reading.levels.silence is True
    assert lowered_ingress.reading.levels.silence is False


def test_ingress_is_published_with_its_own_label_and_no_inputs():
    """
    Ingress is the source of the published graph and carries its own operator
    label, so the webapp never has to map a stage id to a string it might not
    have - §12.2's reason for putting the label on the reading.
    """
    # Arrange
    tracker, _ = _tracker()

    # Act
    tracker.meter_chunk(_wav(_tone(16_000), 16_000))

    # Assert
    (ingress,) = tracker.resolved_stages()
    assert ingress.reading.stage == STAGE_INGRESS
    assert ingress.reading.label == INGRESS_LABEL
    assert ingress.reading.inputs == ()
    assert ingress.depth == 1
    assert ingress.reading.vad is None


def test_a_frame_declared_depth_shifts_ingress_and_everything_below_it():
    """
    A peer that already metered extends the graph upstream (§12.2), so ingress
    is no longer the source. Numbering that restarted at 1 would stack the
    peer's measurement point and this one in the same column.
    """
    # Arrange
    tracker, _ = _tracker()

    # Act
    tracker.meter_chunk(_wav(_tone(16_000), 16_000), declared_stage_depth=2)
    tracker.record_provider_stages((_reading(STAGE_ASR_INPUT, STAGE_INGRESS),))

    # Assert
    ingress, asr_input = tracker.resolved_stages()
    assert (ingress.depth, asr_input.depth) == (3, 4)


def test_provider_stages_follow_ingress_with_their_depths_resolved():
    """
    The shipped whisper topology, end to end: the webserver contributes
    ingress and the provider contributes the two stages only it can see, and
    the three have to land in the columns §12.3 tabulates.
    """
    # Arrange
    tracker, _ = _tracker()
    tracker.meter_chunk(_wav(_tone(16_000), 16_000))

    # Act
    tracker.record_provider_stages(
        (
            _reading(STAGE_ASR_INPUT, STAGE_INGRESS, audio_seconds=0.09),
            _reading(STAGE_VAD, STAGE_ASR_INPUT, audio_seconds=0.04),
        )
    )

    # Assert
    assert [
        (stage.reading.stage, stage.depth)
        for stage in tracker.resolved_stages()
    ] == [(STAGE_INGRESS, 1), (STAGE_ASR_INPUT, 2), (STAGE_VAD, 3)]


def test_a_stage_that_reports_occasionally_keeps_its_last_value():
    """
    Merged by stage id rather than replacing the set: a detector that only
    speaks up when it has something to say would otherwise appear and vanish
    between batches, and an edge whose far end keeps disappearing cannot be
    compared at all.
    """
    # Arrange
    tracker, _ = _tracker()
    vad = VadStats(
        vad_enabled=True,
        speech_active_ratio=0.5,
        segment_count=2,
        mean_segment_duration_sec=0.25,
        speech_to_pause_ratio=1.0,
        snr_db=12.5,
    )
    tracker.record_provider_stages(
        (
            _reading(STAGE_ASR_INPUT, STAGE_INGRESS, audio_seconds=1.0),
            AudioStageReading(
                stage=STAGE_VAD,
                label=STAGE_VAD,
                inputs=(STAGE_ASR_INPUT,),
                levels=None,
                vad=vad,
                audio_seconds=0.4,
            ),
        )
    )

    # Act - the next batch mentions only asr_input.
    tracker.record_provider_stages(
        (_reading(STAGE_ASR_INPUT, STAGE_INGRESS, audio_seconds=2.0),)
    )

    # Assert - asr_input advanced, vad survived with what it last said.
    asr_input, vad_stage = tracker.resolved_stages()
    assert asr_input.reading.audio_seconds == 2.0
    assert vad_stage.reading.vad is vad
    assert vad_stage.reading.audio_seconds == 0.4


def test_nothing_measured_yet_publishes_no_stages_rather_than_zeros():
    """
    "No telemetry" and "zero audio" are different facts, and the dashboard
    maps them to different states. A tracker that had not yet seen a decodable
    chunk must return nothing so the caller can skip the publish entirely.
    """
    # Arrange
    tracker, _ = _tracker()

    # Act
    tracker.record_provider_stages(())

    # Assert
    assert not tracker.resolved_stages()


def test_provider_stages_still_publish_when_ingress_never_decoded():
    """
    An ingress meter that never got a decodable chunk leaves the provider's
    declared input dangling. That is §12.2's incomplete graph: the provider's
    stages must still publish, placed as sources, rather than being suppressed
    for pointing at a stage nobody reported.
    """
    # Arrange
    tracker, _ = _tracker()
    tracker.meter_chunk(b"not audio at all")

    # Act
    tracker.record_provider_stages(
        (_reading(STAGE_ASR_INPUT, STAGE_INGRESS, audio_seconds=1.0),)
    )

    # Assert
    (asr_input,) = tracker.resolved_stages()
    assert (asr_input.reading.stage, asr_input.depth) == (STAGE_ASR_INPUT, 1)


def test_an_undecodable_stream_is_logged_once_and_not_once_per_chunk():
    """
    Chunks arrive ~10/s and a format the meter cannot read fails on every one
    of them, so logging per chunk would bury every other line in the log for
    one fact that never changes.
    """
    # Arrange
    tracker, logger = _tracker()

    # Act
    for _ in range(5):
        tracker.meter_chunk(b"not audio at all")

    # Assert
    logger.debug.assert_called_once()
