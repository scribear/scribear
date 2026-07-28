"""
Unit tests for TranscriptionStreamController's protocol handling

Audio telemetry publishing lives in
`transcription_stream_controller_audio_test.py`; the fixtures both use are in
`conftest.py`.
"""

# pylint: disable=protected-access
# pyright: reportPrivateUsage=false
# Need to call WebsocketHandler protected methods to simulate websocket messages

import asyncio
from unittest.mock import MagicMock

import pytest
from pydantic import BaseModel, ValidationError

from src.transcription_provider_interface import (
    AT_CAPACITY_REASON,
    TranscriptionCapacityError,
    TranscriptionClientError,
    TranscriptionResult,
    TranscriptionSequence,
    TranscriptionSessionInterface,
)
from src.webserver.features.transcription_stream import (
    TranscriptionStreamController,
)
from src.webserver.features.transcription_stream.transcription_stream_messages import (
    TranscriptMessage,
    TranscriptSequence,
)
from src.webserver.shared.metrics import MetricsRegistry

from .conftest import (
    API_KEY,
    AUDIO_CHUNK,
    AUDIO_CHUNK_ID,
    AUDIO_FRAME,
    INIT_TIMEOUT_SEC,
    PROVIDER_UID,
    ROOM_UID,
    SESSION_CONFIG,
    SESSION_UID,
    VALID_AUTH_MESSAGE,
    VALID_CONFIG_MESSAGE,
    VALID_CONFIG_MESSAGE_WITH_UIDS,
    MockTranscriptionSession,
)


@pytest.mark.parametrize(
    "invalid_message",
    ["NOT_JSON", "{}", '{"type":"auth"}', '{"type":"config"}'],
)
@pytest.mark.asyncio
async def test_controller_rejects_invalid_message_formats(
    controller: TranscriptionStreamController, invalid_message: str
):
    """
    Test that controller rejects invalid messages
    """
    # Arrange / Act / Assert
    with pytest.raises(ValidationError):
        await controller._handle_text_message(invalid_message)


@pytest.mark.asyncio
async def test_controller_handles_valid_auth_message(
    controller: TranscriptionStreamController, mock_auth_service: MagicMock
):
    """
    Test that controller parses valid auth message and calls auth service
    """
    # Arrange
    mock_auth_service.is_authenticated.return_value = True

    #  Act
    await controller._handle_text_message(VALID_AUTH_MESSAGE)

    # Assert
    mock_auth_service.is_authenticated.assert_called_once_with(API_KEY)


@pytest.mark.asyncio
async def test_controller_rejects_valid_auth_message_after_authentication(
    controller: TranscriptionStreamController,
    mock_auth_service: MagicMock,
    mock_close_method: MagicMock,
):
    """
    Test that controller rejects second auth message
    """
    # Arrange
    mock_auth_service.is_authenticated.return_value = True

    #  Act
    await controller._handle_text_message(VALID_AUTH_MESSAGE)
    await controller._handle_text_message(VALID_AUTH_MESSAGE)

    # Assert
    mock_auth_service.is_authenticated.assert_called_once()
    mock_close_method.assert_called_once_with(1008, "Unexpected Auth Message")


@pytest.mark.asyncio
async def test_controller_rejects_failed_authentication(
    controller: TranscriptionStreamController,
    mock_auth_service: MagicMock,
    mock_close_method: MagicMock,
):
    """
    Test that controller rejects valid authentication if auth service rejects key
    """
    # Arrange
    mock_auth_service.is_authenticated.return_value = False

    #  Act
    await controller._handle_text_message(VALID_AUTH_MESSAGE)

    # Assert
    mock_auth_service.is_authenticated.assert_called_once_with(API_KEY)
    mock_close_method.assert_called_once_with(1008, "Authentication Failed")


@pytest.mark.asyncio
async def test_controller_handles_valid_config_message_after_authentication(
    controller: TranscriptionStreamController,
    mock_auth_service: MagicMock,
    mock_child_logger: MagicMock,
    mock_provider_registry: MagicMock,
):
    """
    Test that controller parses valid config message and calls transcription service
    """
    # Arrange
    mock_auth_service.is_authenticated.return_value = True
    await controller._handle_text_message(VALID_AUTH_MESSAGE)

    # Act
    await controller._handle_text_message(VALID_CONFIG_MESSAGE)

    # Assert - an older node server that sends no session_uid/room_uid still
    # opens a session; the registry sees them as None.
    mock_provider_registry.create_session.assert_called_once_with(
        PROVIDER_UID, SESSION_CONFIG, None, None, mock_child_logger
    )


@pytest.mark.asyncio
async def test_controller_forwards_session_and_room_uid_from_config_message(
    controller: TranscriptionStreamController,
    mock_auth_service: MagicMock,
    mock_child_logger: MagicMock,
    mock_provider_registry: MagicMock,
):
    """
    Test that session_uid/room_uid on the config message reach the registry
    """
    # Arrange
    mock_auth_service.is_authenticated.return_value = True
    await controller._handle_text_message(VALID_AUTH_MESSAGE)

    # Act
    await controller._handle_text_message(VALID_CONFIG_MESSAGE_WITH_UIDS)

    # Assert
    mock_provider_registry.create_session.assert_called_once_with(
        PROVIDER_UID, SESSION_CONFIG, SESSION_UID, ROOM_UID, mock_child_logger
    )


@pytest.mark.asyncio
async def test_controller_rejects_valid_config_message_before_authentication(
    controller: TranscriptionStreamController,
    mock_provider_registry: MagicMock,
    mock_close_method: MagicMock,
):
    """
    Test that controller rejects valid config message sent before auth message
    """
    # Arrange / Act
    await controller._handle_text_message(VALID_CONFIG_MESSAGE)

    # Assert
    mock_provider_registry.create_session.assert_not_called()
    mock_close_method.assert_called_once_with(1008, "Unexpected Config Message")


@pytest.mark.asyncio
async def test_controller_rejects_valid_config_message_after_configuration(
    controller: TranscriptionStreamController,
    mock_auth_service: MagicMock,
    mock_provider_registry: MagicMock,
    mock_close_method: MagicMock,
):
    """
    Test that controller second valid config message
    """
    # Arrange
    mock_auth_service.is_authenticated.return_value = True
    await controller._handle_text_message(VALID_AUTH_MESSAGE)

    # Act
    await controller._handle_text_message(VALID_CONFIG_MESSAGE)
    await controller._handle_text_message(VALID_CONFIG_MESSAGE)

    # Assert
    mock_provider_registry.create_session.assert_called_once()
    mock_close_method.assert_called_once_with(1008, "Unexpected Config Message")


@pytest.mark.asyncio
async def test_controller_closes_connection_with_no_auth_message(
    controller: TranscriptionStreamController, mock_close_method: MagicMock
):
    # pylint: disable=unused-argument
    # Need to include controller so that controller fixture is created
    """
    Test that controller closes websocket when not auth message is received after timeout
    """
    # Arrange / Act
    await asyncio.sleep(INIT_TIMEOUT_SEC * 2)

    # Assert
    mock_close_method.assert_called_once_with(1008, "Auth Timeout")


@pytest.mark.asyncio
async def test_controller_closes_connection_with_no_config_message(
    controller: TranscriptionStreamController, mock_close_method: MagicMock
):
    """
    Test that controller closes websocket when not config message is received after timeout
    """
    # Arrange / Act
    await controller._handle_text_message(VALID_AUTH_MESSAGE)
    await asyncio.sleep(INIT_TIMEOUT_SEC * 2)

    # Assert
    mock_close_method.assert_called_once_with(1008, "Config Timeout")


@pytest.mark.asyncio
async def test_controller_starts_sessions(
    controller: TranscriptionStreamController,
    mock_auth_service: MagicMock,
    mock_provider_registry: MagicMock,
):
    """
    Test that controller starts transcription session after authentication and configuration
    """
    # Arrange
    mock_session = MagicMock(spec=TranscriptionSessionInterface)

    mock_auth_service.is_authenticated.return_value = True
    mock_provider_registry.create_session.return_value = mock_session

    # Act
    await controller._handle_text_message(VALID_AUTH_MESSAGE)
    await controller._handle_text_message(VALID_CONFIG_MESSAGE)

    # Assert
    mock_session.start_session.assert_called_once()


@pytest.mark.asyncio
async def test_controller_handles_valid_audio_chunk(
    controller: TranscriptionStreamController,
    mock_auth_service: MagicMock,
    mock_provider_registry: MagicMock,
):
    """
    Test that controller forwards audio chunk to transcription session
    """
    # Arrange
    mock_session = MagicMock(spec=TranscriptionSessionInterface)
    mock_session.handle_audio_chunk.return_value = TranscriptionResult()

    mock_auth_service.is_authenticated.return_value = True
    mock_provider_registry.create_session.return_value = mock_session

    await controller._handle_text_message(VALID_AUTH_MESSAGE)
    await controller._handle_text_message(VALID_CONFIG_MESSAGE)

    # Act
    await controller._handle_binary_message(AUDIO_FRAME)

    # Assert
    mock_session.handle_audio_chunk.assert_called_once_with(
        AUDIO_CHUNK_ID, AUDIO_CHUNK
    )


@pytest.mark.asyncio
async def test_controller_rejects_valid_audio_chunk_message_before_authentication(
    controller: TranscriptionStreamController,
    mock_provider_registry: MagicMock,
    mock_close_method: MagicMock,
):
    """
    Test that controller rejects valid audio chunk sent before auth message
    """
    # Arrange / Act
    await controller._handle_binary_message(AUDIO_CHUNK)

    # Assert
    mock_provider_registry.create_session.assert_not_called()
    mock_close_method.assert_called_once_with(
        1008, "Audio chunk before authentication"
    )


@pytest.mark.asyncio
async def test_controller_rejects_valid_audio_chunk_message_before_configuration(
    controller: TranscriptionStreamController,
    mock_auth_service: MagicMock,
    mock_provider_registry: MagicMock,
    mock_close_method: MagicMock,
):
    """
    Test that controller rejects valid audio chunk sent before config message
    """
    # Arrange
    mock_auth_service.is_authenticated.return_value = True
    await controller._handle_text_message(VALID_AUTH_MESSAGE)

    # Act
    await controller._handle_binary_message(AUDIO_CHUNK)

    # Assert
    mock_provider_registry.create_session.assert_not_called()
    mock_close_method.assert_called_once_with(
        1008, "Audio chunk before configuration"
    )


@pytest.mark.asyncio
async def test_controller_handles_in_progress_transcription_results(
    controller: TranscriptionStreamController,
    mock_auth_service: MagicMock,
    mock_provider_registry: MagicMock,
    mock_send_method: MagicMock,
):
    """
    Test that controller sends a combined transcript message with only in-progress data
    """
    # Arrange
    text = ["Hello, ", "World"]
    starts = [0.0, 0.3]
    ends = [0.2, 0.6]

    mock_session = MockTranscriptionSession()
    mock_auth_service.is_authenticated.return_value = True
    mock_provider_registry.create_session.return_value = mock_session

    await controller._handle_text_message(VALID_AUTH_MESSAGE)
    await controller._handle_text_message(VALID_CONFIG_MESSAGE)

    # Act
    mock_session.emit(
        TranscriptionSessionInterface.TranscriptionResultEvent,
        TranscriptionResult(
            in_progress=TranscriptionSequence(text, starts, ends)
        ),
    )

    # Assert
    mock_send_method.assert_called_once_with(
        TranscriptMessage(
            final=None, in_progress=TranscriptSequence(text, starts, ends)
        )
    )


@pytest.mark.asyncio
async def test_controller_handles_final_transcription_results(
    controller: TranscriptionStreamController,
    mock_auth_service: MagicMock,
    mock_provider_registry: MagicMock,
    mock_send_method: MagicMock,
):
    """
    Test that controller sends a combined transcript message with only final data
    """
    # Arrange
    text = ["Hello, ", "World"]
    starts = [0.0, 0.3]
    ends = [0.2, 0.6]

    mock_session = MockTranscriptionSession()
    mock_auth_service.is_authenticated.return_value = True
    mock_provider_registry.create_session.return_value = mock_session

    await controller._handle_text_message(VALID_AUTH_MESSAGE)
    await controller._handle_text_message(VALID_CONFIG_MESSAGE)

    # Act
    mock_session.emit(
        TranscriptionSessionInterface.TranscriptionResultEvent,
        TranscriptionResult(final=TranscriptionSequence(text, starts, ends)),
    )

    # Assert
    mock_send_method.assert_called_once_with(
        TranscriptMessage(
            final=TranscriptSequence(text, starts, ends), in_progress=None
        )
    )


@pytest.mark.asyncio
async def test_controller_handles_in_progress_and_final_transcription_results(
    controller: TranscriptionStreamController,
    mock_auth_service: MagicMock,
    mock_provider_registry: MagicMock,
    mock_send_method: MagicMock,
):
    """
    Test that controller sends a single combined transcript message with both
        in-progress and final data
    """
    # Arrange
    final_text = ["Hello, ", "World"]
    final_starts = [0.0, 0.3]
    final_ends = [0.2, 0.6]
    ip_text = ["Some ", "words"]
    ip_starts = [0.6, 0.7]
    ip_ends = [0.7, 0.8]

    mock_session = MockTranscriptionSession()
    mock_auth_service.is_authenticated.return_value = True
    mock_provider_registry.create_session.return_value = mock_session

    await controller._handle_text_message(VALID_AUTH_MESSAGE)
    await controller._handle_text_message(VALID_CONFIG_MESSAGE)

    # Act
    mock_session.emit(
        TranscriptionSessionInterface.TranscriptionResultEvent,
        TranscriptionResult(
            in_progress=TranscriptionSequence(ip_text, ip_starts, ip_ends),
            final=TranscriptionSequence(final_text, final_starts, final_ends),
        ),
    )

    # Assert
    mock_send_method.assert_called_once_with(
        TranscriptMessage(
            final=TranscriptSequence(final_text, final_starts, final_ends),
            in_progress=TranscriptSequence(ip_text, ip_starts, ip_ends),
        )
    )


@pytest.mark.asyncio
async def test_controller_handles_no_transcription_results(
    controller: TranscriptionStreamController,
    mock_auth_service: MagicMock,
    mock_provider_registry: MagicMock,
    mock_send_method: MagicMock,
):
    """
    Test that controller doesn't send messages if no transcription results are returned
    """
    # Arrange
    mock_session = MagicMock(spec=TranscriptionSessionInterface)
    mock_session.handle_audio_chunk.return_value = TranscriptionResult()

    mock_auth_service.is_authenticated.return_value = True
    mock_provider_registry.create_session.return_value = mock_session

    await controller._handle_text_message(VALID_AUTH_MESSAGE)
    await controller._handle_text_message(VALID_CONFIG_MESSAGE)

    # Act
    await controller._handle_binary_message(AUDIO_FRAME)

    # Assert
    mock_send_method.assert_not_called()


@pytest.mark.asyncio
async def test_controller_ends_session_on_close(
    mock_config: MagicMock,
    mock_logger: MagicMock,
    mock_auth_service: MagicMock,
    mock_provider_registry: MagicMock,
    mock_websocket: MagicMock,
    mock_send_method: MagicMock,
    mock_close_method: MagicMock,
):
    """
    Test that controller ends transcription session when websocket closes
    """
    # Arrange
    controller = TranscriptionStreamController(
        mock_config,
        mock_logger,
        mock_auth_service,
        mock_provider_registry,
        MetricsRegistry(),
        PROVIDER_UID,
        mock_websocket,
    )

    controller.send = mock_send_method
    controller.close = mock_close_method

    mock_session = MagicMock(spec=TranscriptionSessionInterface)
    mock_auth_service.is_authenticated.return_value = True
    mock_provider_registry.create_session.return_value = mock_session
    await controller._handle_text_message(VALID_AUTH_MESSAGE)
    await controller._handle_text_message(VALID_CONFIG_MESSAGE)

    # Act
    controller._handle_close(1000, "Test End")

    # Assert
    mock_session.end_session.assert_called_once()


@pytest.mark.asyncio
async def test_controller_handles_validation_errors(
    controller: TranscriptionStreamController, mock_close_method: MagicMock
):
    """
    Test that controller error handler handles validation errors by closing connection
    """
    # Arrange
    error = None
    try:

        class Message(BaseModel):
            """
            Test pydantic model to generate a ValidationError
            """

            prop: int

        Message(**{"prop": "invalid"})
        assert False
    except ValidationError as e:
        error = e

    # Act
    return_value = controller._handle_error(error)

    # Assert
    mock_close_method.assert_called_once_with(1007, "Invalid message format")
    assert return_value is True


@pytest.mark.asyncio
async def test_controller_handles_transcription_client_errors(
    controller: TranscriptionStreamController, mock_close_method: MagicMock
):
    """
    Test that controller error handler handles transcription client errors by closing connection
    """
    # Arrange
    error_msg = "Client caused some transcription error"

    # Act
    return_value = controller._handle_error(TranscriptionClientError(error_msg))

    # Assert
    mock_close_method.assert_called_once_with(1007, error_msg)
    assert return_value is True


@pytest.mark.asyncio
async def test_controller_closes_1013_for_a_capacity_refusal(
    controller: TranscriptionStreamController, mock_close_method: MagicMock
):
    """
    Test a capacity refusal closes 1013 "Try Again Later", never 1007

    1007 is "invalid frame payload data" - it tells the client it sent
    something malformed. PR #171 removed exactly that misattribution for buffer
    overflow, and routing a busy refusal through it would reintroduce the same
    mistake wearing a new hat: the client did nothing wrong, the service has no
    room right now, and those two need different client behaviour (give up
    versus retry later).

    The reason string is a wire contract, not a log line - the node server keys
    "refused" apart from "crashed" off it (PLAN-AdmissionControl.md §4).
    """
    # Act
    return_value = controller._handle_error(
        TranscriptionCapacityError(AT_CAPACITY_REASON)
    )

    # Assert
    mock_close_method.assert_called_once_with(1013, AT_CAPACITY_REASON)
    assert return_value is True


@pytest.mark.asyncio
async def test_capacity_refusal_during_config_reaches_the_error_handler(
    controller: TranscriptionStreamController,
    mock_auth_service: MagicMock,
    mock_provider_registry: MagicMock,
    mock_close_method: MagicMock,
):
    """
    Test a refusal raised from the CONFIG step closes the socket with 1013

    The end-to-end path through the controller, not just the mapping in
    isolation: the registry refuses inside `create_session`, the error travels
    out of `_config` through `WebsocketHandler`'s receive loop, and the socket
    closes 1013. Worth pinning separately because the controller sets
    `self._service` only after `start()` returns - a refusal must leave the
    connection with no service attached and must NOT fall through to the
    generic 1011 "Internal Server Error", which would tell an operator the
    service crashed.
    """
    # Arrange
    mock_auth_service.is_authenticated.return_value = True
    mock_provider_registry.create_session.side_effect = (
        TranscriptionCapacityError(AT_CAPACITY_REASON)
    )
    await controller._handle_text_message(VALID_AUTH_MESSAGE)

    # Act - the same path receive_messages() takes when a handler raises
    try:
        await controller._handle_text_message(VALID_CONFIG_MESSAGE)
        assert False
    except TranscriptionCapacityError as error:
        assert controller._handle_error(error) is True

    # Assert
    mock_close_method.assert_called_once_with(1013, AT_CAPACITY_REASON)
    assert controller._service is None


@pytest.mark.asyncio
async def test_controller_handles_non_client_transcription_errors(
    controller: TranscriptionStreamController,
):
    """
    Test that controller error handler handles transcription errors that were unexpected
        allowing WebsocketHandler default error handling behavior
    """
    # Arrange
    error_msg = "Server caused some transcription error"

    # Act
    return_value = controller._handle_error(Exception(error_msg))

    # Assert
    assert return_value is False
