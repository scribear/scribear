"""
Unit tests for TranscriptionStreamController
"""

# pylint: disable=protected-access
# pyright: reportPrivateUsage=false
# Need to call WebsocketHandler protected methods to simulate websocket messages

import asyncio
import json
from os import path
from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from pydantic import BaseModel, ValidationError
from pytest_mock import MockerFixture
from starlette.websockets import WebSocket, WebSocketState

from src.shared.config import Config
from src.shared.logger import Logger
from src.shared.utils.audio_frame_protocol import encode_audio_frame
from src.shared.utils.audio_meter import AudioLevelStats
from src.transcription_provider_interface import (
    TranscriptionClientError,
    TranscriptionResult,
    TranscriptionSequence,
    TranscriptionSessionInterface,
)
from src.webserver.features.telemetry import RedisSessionAudioPublisher
from src.webserver.features.transcription_stream import (
    TranscriptionStreamController,
)
from src.webserver.features.transcription_stream.transcription_stream_messages import (
    TranscriptMessage,
    TranscriptSequence,
)
from src.webserver.shared.auth_service import AuthService
from src.webserver.shared.metrics import MetricsRegistry
from src.webserver.shared.transcription_provider_registry import (
    TranscriptionProviderRegistry,
)

AUDIO_DIR = path.normpath(
    path.join(
        __file__,
        "..",
        "..",
        "..",
        "..",
        "..",
        "..",
        "..",
        "test_audio_files/musical_chords",
    )
)
with open(path.join(AUDIO_DIR, "mono_f64le.pcm"), "rb") as f:
    AUDIO_CHUNK = f.read()

# The controller receives SAFP-framed binary; wrap the raw audio the way the
# node server would before forwarding.
AUDIO_CHUNK_ID = "test-chunk"
AUDIO_FRAME = encode_audio_frame(AUDIO_CHUNK_ID, AUDIO_CHUNK)

INIT_TIMEOUT_SEC = 0.1

PROVIDER_UID = "TEST_PROVIDER_UID"
API_KEY = "secret-test-key-12345"
SESSION_CONFIG = "SESSION_CONFIG"
SESSION_UID = "session-1"
ROOM_UID = "room-1"

VALID_AUTH_MESSAGE = json.dumps({"type": "auth", "api_key": API_KEY})
VALID_CONFIG_MESSAGE = json.dumps({"type": "config", "config": SESSION_CONFIG})
VALID_CONFIG_MESSAGE_WITH_UIDS = json.dumps(
    {
        "type": "config",
        "config": SESSION_CONFIG,
        "session_uid": SESSION_UID,
        "room_uid": ROOM_UID,
    }
)


class MockTranscriptionSession(TranscriptionSessionInterface):
    """
    Dummy transcription session interface implementation for testing
    """

    def handle_audio_chunk(self, chunk_id: str, chunk: bytes):
        return


@pytest.fixture
def mock_config():
    """
    Pytest fixture to create a mock config object for tests.
    """
    mock = MagicMock(spec=Config)
    mock.ws_init_timeout_sec = INIT_TIMEOUT_SEC
    return mock


@pytest.fixture
def mock_child_logger():
    """
    Create a child logger instance for mock logger to return.
    """
    return MagicMock(spec=Logger)


@pytest.fixture
def mock_logger(mock_child_logger: MagicMock):
    """
    Create a mocked logger instance for tests
    """
    mock_logger = MagicMock(spec=Logger)
    mock_logger.child.return_value = mock_child_logger
    return mock_logger


@pytest.fixture
def mock_auth_service():
    """
    Create a mocked auth service instance for tests
    """
    return MagicMock(spec=AuthService)


@pytest.fixture
def mock_provider_registry():
    """
    Create a mocked transcription provider registry instance for tests
    """
    return MagicMock(spec=TranscriptionProviderRegistry)


@pytest.fixture
def mock_audio_publisher():
    """
    Create a mocked audio-stats publisher instance for tests
    """
    return MagicMock(spec=RedisSessionAudioPublisher)


@pytest.fixture
def mock_websocket():
    """
    Create a mocked websocket instance for tests
    """
    ws = MagicMock(spec=WebSocket)
    ws.application_state = WebSocketState.CONNECTED
    ws.client_state = WebSocketState.CONNECTED
    return ws


@pytest.fixture
def mock_send_method(mocker: MockerFixture):
    """
    Mock function to override WebsocketHandler send method
    """
    return mocker.Mock()


@pytest.fixture
def mock_close_method(mocker: MockerFixture):
    """
    Mock function to override WebsocketHandler close method
    """
    return mocker.Mock()


@pytest_asyncio.fixture
async def controller(
    mock_config: MagicMock,
    mock_logger: MagicMock,
    mock_auth_service: MagicMock,
    mock_provider_registry: MagicMock,
    mock_websocket: MagicMock,
    mock_send_method: MagicMock,
    mock_close_method: MagicMock,
):
    """
    Create fresh TranscriptionStreamController with mocked dependencies for each test
    """
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

    yield controller

    # Give controller a chance to clean up
    controller._handle_close(1000, "Test End")


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
async def test_controller_publishes_audio_stats_to_the_backplane(
    mock_config: MagicMock,
    mock_logger: MagicMock,
    mock_auth_service: MagicMock,
    mock_provider_registry: MagicMock,
    mock_websocket: MagicMock,
    mock_send_method: MagicMock,
    mock_close_method: MagicMock,
    mock_audio_publisher: MagicMock,
):
    """
    Test that a result carrying audio_stats reaches the audio publisher with
    this connection's session_uid/room_uid, via the second listener alongside
    _handle_transcription_result - not instead of it.
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
        mock_audio_publisher,
    )
    controller.send = mock_send_method
    controller.close = mock_close_method

    mock_session = MockTranscriptionSession()
    mock_auth_service.is_authenticated.return_value = True
    mock_provider_registry.create_session.return_value = mock_session

    await controller._handle_text_message(VALID_AUTH_MESSAGE)
    await controller._handle_text_message(VALID_CONFIG_MESSAGE_WITH_UIDS)

    stats = AudioLevelStats(
        rms_dbfs=-20.0,
        peak_dbfs=-10.0,
        clipping_pct=0.0,
        silence=False,
        noise_floor_dbfs=-45.0,
    )

    # Act
    mock_session.emit(
        TranscriptionSessionInterface.TranscriptionResultEvent,
        TranscriptionResult(audio_stats=stats),
    )

    # Assert
    mock_audio_publisher.publish.assert_called_once_with(
        SESSION_UID, ROOM_UID, stats
    )
    # Still forwarded to the WS-serialization listener.
    mock_send_method.assert_called_once()

    controller._handle_close(1000, "Test End")


@pytest.mark.asyncio
async def test_controller_does_not_publish_when_result_has_no_audio_stats(
    controller: TranscriptionStreamController,
    mock_auth_service: MagicMock,
    mock_provider_registry: MagicMock,
):
    """
    A result with no audio_stats (debug/lumen_granite, or Whisper before its
    meter's window has filled) is not forwarded to the publisher.
    """
    # Arrange - the shared `controller` fixture wires audio_publisher=None,
    # so this also exercises the "no publisher configured" no-op path.
    mock_session = MockTranscriptionSession()
    mock_auth_service.is_authenticated.return_value = True
    mock_provider_registry.create_session.return_value = mock_session

    await controller._handle_text_message(VALID_AUTH_MESSAGE)
    await controller._handle_text_message(VALID_CONFIG_MESSAGE)

    # Act / Assert - must not raise despite no publisher being configured.
    mock_session.emit(
        TranscriptionSessionInterface.TranscriptionResultEvent,
        TranscriptionResult(),
    )


@pytest.mark.asyncio
async def test_controller_forgets_session_on_close(
    mock_config: MagicMock,
    mock_logger: MagicMock,
    mock_auth_service: MagicMock,
    mock_provider_registry: MagicMock,
    mock_websocket: MagicMock,
    mock_send_method: MagicMock,
    mock_close_method: MagicMock,
    mock_audio_publisher: MagicMock,
):
    """
    Test that closing the connection drops this session's throttle-tracking
    state in the publisher, so it does not grow with every session ever
    served.
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
        mock_audio_publisher,
    )
    controller.send = mock_send_method
    controller.close = mock_close_method

    mock_session = MagicMock(spec=TranscriptionSessionInterface)
    mock_auth_service.is_authenticated.return_value = True
    mock_provider_registry.create_session.return_value = mock_session
    await controller._handle_text_message(VALID_AUTH_MESSAGE)
    await controller._handle_text_message(VALID_CONFIG_MESSAGE_WITH_UIDS)

    # Act
    controller._handle_close(1000, "Test End")

    # Assert
    mock_audio_publisher.forget.assert_called_once_with(SESSION_UID)


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
