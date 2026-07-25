"""
Shared fixtures and constants for the transcription-stream controller tests

The controller's protocol behaviour and its audio-telemetry behaviour are
tested in two modules (one file covering both outgrew what is readable), and
both need the same eight collaborators plus the same framed audio - so the
scaffolding lives here rather than being duplicated, following the same
conftest-per-directory shape `tests/unit/shared/utils/worker_pool` uses.
"""

# pylint: disable=protected-access
# pyright: reportPrivateUsage=false
# Need to call WebsocketHandler protected methods to simulate websocket messages

import json
from os import path
from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from pytest_mock import MockerFixture
from starlette.websockets import WebSocket, WebSocketState

from src.shared.config import Config
from src.shared.logger import Logger
from src.shared.utils.audio_frame_protocol import encode_audio_frame
from src.transcription_provider_interface import TranscriptionSessionInterface
from src.webserver.features.telemetry import RedisSessionAudioPublisher
from src.webserver.features.transcription_stream import (
    TranscriptionStreamController,
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

# Headerless PCM: the ingress meter cannot read a sample rate out of it, so
# every test using this frame also asserts that unmeterable audio still reaches
# the session.
with open(path.join(AUDIO_DIR, "mono_f64le.wav"), "rb") as f:
    CONTAINED_AUDIO_CHUNK = f.read()

CONTAINED_AUDIO_SEC = 4.0

# The controller receives SAFP-framed binary; wrap the raw audio the way the
# node server would before forwarding.
AUDIO_CHUNK_ID = "test-chunk"
AUDIO_FRAME = encode_audio_frame(AUDIO_CHUNK_ID, AUDIO_CHUNK)
CONTAINED_AUDIO_FRAME = encode_audio_frame(
    AUDIO_CHUNK_ID, CONTAINED_AUDIO_CHUNK
)

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
    mock.audio_silence_threshold = 0.01
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
    Create a mocked audio-telemetry publisher instance for tests

    `is_due` defaults to True so a test says nothing about throttling unless it
    means to: the controller asks it before assembling a payload, so leaving it
    as a bare MagicMock would make the gating accidental rather than stated.
    """
    publisher = MagicMock(spec=RedisSessionAudioPublisher)
    publisher.is_due.return_value = True
    return publisher


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


@pytest.fixture
def mock_session(mock_provider_registry: MagicMock):
    """
    An event-emitting stand-in for the provider's session, already registered
    so that a config message hands it back.
    """
    session = MockTranscriptionSession()
    mock_provider_registry.create_session.return_value = session
    return session


@pytest_asyncio.fixture
async def publishing_controller(
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
    Create a controller wired to a telemetry backplane

    Separate from `controller` rather than parameterising it: the audio
    telemetry tests need the publisher and every other test needs to prove the
    controller runs without one, and the eight collaborators in between are the
    same either way.
    """
    mock_auth_service.is_authenticated.return_value = True

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

    yield controller

    controller._handle_close(1000, "Test End")


async def authenticate_and_configure(controller: TranscriptionStreamController):
    """Walks the auth -> config handshake, carrying session and room uids."""
    await controller._handle_text_message(VALID_AUTH_MESSAGE)
    await controller._handle_text_message(VALID_CONFIG_MESSAGE_WITH_UIDS)


def published_once(mock_audio_publisher: MagicMock):
    """The (session_uid, room_uid, stages) of the one publish that happened."""
    mock_audio_publisher.publish.assert_called_once()
    return mock_audio_publisher.publish.call_args.args
