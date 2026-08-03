"""
Unit tests for TranscriptionStreamController's audio-telemetry publishing

Split from the protocol tests because the two concerns share only the
handshake: these exercise what §12.1 of the audio-telemetry plan changed -
telemetry that exists for every provider, and is not gated on the ASR
producing. Shared fixtures are in `conftest.py`.
"""

# pylint: disable=protected-access
# pyright: reportPrivateUsage=false
# Need to call WebsocketHandler protected methods to simulate websocket messages

from unittest.mock import MagicMock

import pytest

from src.transcription_provider_interface import (
    STAGE_ASR_INPUT,
    STAGE_INGRESS,
    AudioStageReading,
    TranscriptionResult,
    TranscriptionSessionInterface,
)
from src.webserver.features.telemetry import SessionAudioTracker
from src.webserver.features.transcription_stream import (
    TranscriptionStreamController,
)

from .conftest import (
    AUDIO_CHUNK,
    AUDIO_CHUNK_ID,
    AUDIO_FRAME,
    CONTAINED_AUDIO_FRAME,
    CONTAINED_AUDIO_SEC,
    ROOM_UID,
    SESSION_UID,
    VALID_AUTH_MESSAGE,
    VALID_CONFIG_MESSAGE,
    MockTranscriptionSession,
    authenticate_and_configure,
    published_once,
)


@pytest.mark.asyncio
async def test_controller_publishes_the_provider_stages_it_was_told_about(
    publishing_controller: TranscriptionStreamController,
    mock_session: MockTranscriptionSession,
    mock_audio_publisher: MagicMock,
    mock_send_method: MagicMock,
):
    """
    Test that a result's audio_stages reach the publisher, resolved against
    this connection's own ingress reading and keyed by its session/room uid

    Via the second listener alongside _handle_transcription_result, not instead
    of it: WS-serialization and telemetry-publishing react to the same event
    but are independent concerns.
    """
    # Arrange
    await authenticate_and_configure(publishing_controller)
    await publishing_controller._handle_binary_message(CONTAINED_AUDIO_FRAME)
    mock_audio_publisher.publish.reset_mock()

    # Act
    mock_session.emit(
        TranscriptionSessionInterface.TranscriptionResultEvent,
        TranscriptionResult(
            audio_stages=(
                AudioStageReading(
                    stage=STAGE_ASR_INPUT,
                    label="ASR input (worker decode)",
                    inputs=(STAGE_INGRESS,),
                    levels=None,
                    vad=None,
                    audio_seconds=3.9,
                ),
            )
        ),
    )

    # Assert
    session_uid, room_uid, stages = published_once(mock_audio_publisher)
    assert (session_uid, room_uid) == (SESSION_UID, ROOM_UID)
    assert [(stage.reading.stage, stage.depth) for stage in stages] == [
        (STAGE_INGRESS, 1),
        (STAGE_ASR_INPUT, 2),
    ]
    # Still forwarded to the WS-serialization listener.
    mock_send_method.assert_called_once()


@pytest.mark.asyncio
async def test_controller_publishes_ingress_for_a_provider_that_reports_nothing(
    publishing_controller: TranscriptionStreamController,
    mock_session: MockTranscriptionSession,
    mock_audio_publisher: MagicMock,
):
    """
    Test the regression §12.1 was written for

    This handler used to early-return when a result carried no stats, so the
    two providers that never set any - `debug` and `lumen_granite`, half of
    what provider_config.template.json ships - published no audio snapshot at
    all, and `deriveAudioStatus` rendered every healthy session on them as a
    red "no audio reaching ASR" chip beside a green connectivity chip.
    """
    # Arrange
    await authenticate_and_configure(publishing_controller)
    await publishing_controller._handle_binary_message(CONTAINED_AUDIO_FRAME)
    mock_audio_publisher.publish.reset_mock()

    # Act - a result from a provider that measures nothing.
    mock_session.emit(
        TranscriptionSessionInterface.TranscriptionResultEvent,
        TranscriptionResult(),
    )

    # Assert
    _, _, stages = published_once(mock_audio_publisher)
    assert [stage.reading.stage for stage in stages] == [STAGE_INGRESS]
    assert stages[0].reading.levels is not None


@pytest.mark.asyncio
async def test_controller_publishes_on_inbound_audio_without_any_result(
    publishing_controller: TranscriptionStreamController,
    mock_audio_publisher: MagicMock,
):
    """
    Test audio telemetry does not wait for the ASR to produce

    Publishing used to be triggered only by a TranscriptionResult arriving, so
    "audio is fine" silently also asserted "the ASR is producing" and a stalled
    model read as a microphone fault (§12.1). D1 makes audio a separate axis
    from connectivity, which is only true if the measurement is taken somewhere
    connectivity cannot suppress it.
    """
    # Arrange
    await authenticate_and_configure(publishing_controller)

    # Act - no result is ever emitted.
    await publishing_controller._handle_binary_message(CONTAINED_AUDIO_FRAME)

    # Assert
    _, _, stages = published_once(mock_audio_publisher)
    assert [stage.reading.stage for stage in stages] == [STAGE_INGRESS]
    assert stages[0].reading.audio_seconds == CONTAINED_AUDIO_SEC


@pytest.mark.asyncio
async def test_controller_does_not_snapshot_when_the_throttle_would_drop_it(
    publishing_controller: TranscriptionStreamController,
    mock_audio_publisher: MagicMock,
):
    """
    Test the payload is not assembled when no write would happen

    Assembling it costs an AudioMeter.snapshot() - ~218 us against ~29 us to
    meter a chunk, at ~10 chunks/s per session (§12.9). Paying that for a write
    the throttle then drops is the one part of ingress metering whose cost is
    not self-evidently free, so the gate is asserted on the tracker rather than
    only on the publisher.
    """
    # Arrange
    tracker = MagicMock(spec=SessionAudioTracker)
    publishing_controller._audio_tracker = tracker
    mock_audio_publisher.is_due.return_value = False
    await authenticate_and_configure(publishing_controller)

    # Act
    await publishing_controller._handle_binary_message(CONTAINED_AUDIO_FRAME)

    # Assert - metered (cheap), but never snapshotted (expensive).
    tracker.meter_chunk.assert_called_once()
    tracker.resolved_stages.assert_not_called()
    mock_audio_publisher.publish.assert_not_called()


@pytest.mark.asyncio
async def test_controller_publishes_nothing_when_nothing_has_been_measured(
    publishing_controller: TranscriptionStreamController,
    mock_session: MockTranscriptionSession,
    mock_audio_publisher: MagicMock,
):
    """
    Test a session with no measurement yet publishes no snapshot at all

    "No telemetry" and "zero audio" are different facts and the dashboard maps
    them to different states, so an empty graph must not be written as one.
    Skipping also leaves the throttle window open for the first real reading
    instead of spending it on a payload with no numbers in it.
    """
    # Arrange - a result arrives before any decodable audio has.
    await authenticate_and_configure(publishing_controller)

    # Act
    mock_session.emit(
        TranscriptionSessionInterface.TranscriptionResultEvent,
        TranscriptionResult(),
    )

    # Assert
    mock_audio_publisher.publish.assert_not_called()


@pytest.mark.asyncio
async def test_controller_forwards_a_chunk_the_ingress_meter_cannot_decode(
    publishing_controller: TranscriptionStreamController,
    mock_provider_registry: MagicMock,
    mock_audio_publisher: MagicMock,
):
    """
    Test unmeterable audio still reaches the session

    Headerless PCM has no sample rate for the ingress meter to read, and the
    provider's own decoder is the thing that validates a chunk properly. A
    metering failure that suppressed the chunk - or escaped - would cost the
    session its audio for the sake of a dashboard.
    """
    # Arrange
    mock_session = MagicMock(spec=TranscriptionSessionInterface)
    mock_provider_registry.create_session.return_value = mock_session
    await authenticate_and_configure(publishing_controller)

    # Act
    await publishing_controller._handle_binary_message(AUDIO_FRAME)

    # Assert
    mock_session.handle_audio_chunk.assert_called_once_with(
        AUDIO_CHUNK_ID, AUDIO_CHUNK
    )
    mock_audio_publisher.publish.assert_not_called()


@pytest.mark.asyncio
async def test_controller_publishes_nothing_when_no_backplane_is_configured(
    controller: TranscriptionStreamController,
    mock_auth_service: MagicMock,
    mock_provider_registry: MagicMock,
):
    """
    Test a deployment with no Redis still meters and still runs

    The tracker is built unconditionally, so the "no publisher" path has to be
    the thing that short-circuits - and it has to do so before anything is
    assembled, not by handing a payload to None.
    """
    # Arrange - the shared `controller` fixture wires audio_publisher=None.
    mock_session = MockTranscriptionSession()
    mock_auth_service.is_authenticated.return_value = True
    mock_provider_registry.create_session.return_value = mock_session

    await controller._handle_text_message(VALID_AUTH_MESSAGE)
    await controller._handle_text_message(VALID_CONFIG_MESSAGE)

    # Act / Assert - must not raise despite no publisher being configured.
    await controller._handle_binary_message(CONTAINED_AUDIO_FRAME)
    mock_session.emit(
        TranscriptionSessionInterface.TranscriptionResultEvent,
        TranscriptionResult(),
    )


@pytest.mark.asyncio
async def test_controller_forgets_session_on_close(
    publishing_controller: TranscriptionStreamController,
    mock_provider_registry: MagicMock,
    mock_audio_publisher: MagicMock,
):
    """
    Test that closing the connection drops this session's throttle-tracking
    state in the publisher, so it does not grow with every session ever
    served.
    """
    # Arrange
    mock_provider_registry.create_session.return_value = MagicMock(
        spec=TranscriptionSessionInterface
    )
    await authenticate_and_configure(publishing_controller)

    # Act
    publishing_controller._handle_close(1000, "Test End")

    # Assert
    mock_audio_publisher.forget.assert_called_once_with(SESSION_UID)
