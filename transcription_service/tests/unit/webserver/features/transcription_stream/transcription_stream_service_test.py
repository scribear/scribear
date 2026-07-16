"""
Unit tests for TranscriptionStreamService
"""

# pylint: disable=protected-access
# pyright: reportPrivateUsage=false

from unittest.mock import MagicMock

import pytest

from src.shared.logger import Logger
from src.transcription_provider_interface import (
    TranscriptionClientError,
    TranscriptionResult,
    TranscriptionSequence,
    TranscriptionSessionInterface,
)
from src.webserver.features.transcription_stream import (
    TranscriptionStreamService,
)
from src.webserver.shared.transcription_provider_registry import (
    TranscriptionProviderRegistry,
)

PROVIDER_KEY = "TEST_PROVIDER"
SESSION_CONFIG = "SESSION_CONFIG"


class FakeSession(TranscriptionSessionInterface):
    """
    Concrete TranscriptionSessionInterface used so the service wires real
    EventEmitter callbacks rather than MagicMock attributes.
    """

    def __init__(self):
        super().__init__()
        self.start_session = MagicMock()  # type: ignore[method-assign]
        self.end_session = MagicMock()  # type: ignore[method-assign]
        self.handle_audio_chunk = MagicMock()  # type: ignore[method-assign]

    # The abstract method is patched in __init__ above; this satisfies the
    # ABC check at class-construction time.
    def handle_audio_chunk(  # type: ignore[override]
        self, chunk_id: str, chunk: bytes
    ):
        return None


@pytest.fixture
def mock_logger():
    """
    Mock logger fixture.
    """
    return MagicMock(spec=Logger)


@pytest.fixture
def mock_provider_registry():
    """
    Mock provider registry fixture.
    """
    return MagicMock(spec=TranscriptionProviderRegistry)


@pytest.fixture
def fake_session(mock_provider_registry: MagicMock):
    """
    Wire the mock registry to return a real FakeSession when asked for one.
    """
    session = FakeSession()
    mock_provider_registry.create_session.return_value = session
    return session


@pytest.fixture
def service(
    mock_logger: MagicMock, mock_provider_registry: MagicMock
) -> TranscriptionStreamService:
    """
    Fresh service with mocked dependencies.
    """
    return TranscriptionStreamService(
        mock_logger, mock_provider_registry, PROVIDER_KEY, SESSION_CONFIG
    )


def test_start_creates_session_through_registry(
    service: TranscriptionStreamService,
    mock_provider_registry: MagicMock,
    mock_logger: MagicMock,
    fake_session: FakeSession,
):
    """
    Service.start() asks the registry for a session matching the configured
    provider key and immediately starts it.
    """
    # Arrange / Act
    service.start()

    # Assert
    mock_provider_registry.create_session.assert_called_once_with(
        PROVIDER_KEY, SESSION_CONFIG, mock_logger
    )
    fake_session.start_session.assert_called_once()


def test_start_propagates_unknown_provider_error(
    service: TranscriptionStreamService, mock_provider_registry: MagicMock
):
    """
    Service.start() lets TranscriptionClientError bubble so the controller
    can map it to a 1007 close.
    """
    # Arrange
    mock_provider_registry.create_session.side_effect = (
        TranscriptionClientError("bad provider")
    )

    # Act / Assert
    with pytest.raises(TranscriptionClientError):
        service.start()


def test_handle_audio_chunk_forwards_to_session(
    service: TranscriptionStreamService, fake_session: FakeSession
):
    """
    Audio chunks flow straight through to the underlying session once
    start() has been called.
    """
    # Arrange
    service.start()
    chunk = b"\x01\x02\x03"

    # Act
    service.handle_audio_chunk("chunk-1", chunk)

    # Assert
    fake_session.handle_audio_chunk.assert_called_once_with("chunk-1", chunk)


def test_handle_audio_chunk_is_no_op_before_start(
    service: TranscriptionStreamService,
):
    """
    Without a session, handle_audio_chunk silently drops the chunk so the
    service can't crash from out-of-order controller calls.
    """
    # Arrange / Act
    service.handle_audio_chunk("chunk-1", b"\x01")

    # Assert - no exception raised, no session call attempted (no session yet).


def test_close_ends_underlying_session(
    service: TranscriptionStreamService, fake_session: FakeSession
):
    """
    Closing the service ends the session and is idempotent on repeat calls.
    """
    # Arrange
    service.start()

    # Act
    service.close()
    service.close()

    # Assert
    fake_session.end_session.assert_called_once()


def test_transcript_results_are_forwarded(
    service: TranscriptionStreamService, fake_session: FakeSession
):
    """
    Transcripts emitted by the underlying session are re-emitted on the
    service's own TranscriptionResultEvent so the controller can serialize
    them.
    """
    # Arrange
    received: list[TranscriptionResult] = []
    service.on(
        TranscriptionStreamService.TranscriptionResultEvent, received.append
    )
    service.start()
    result = TranscriptionResult(
        final=TranscriptionSequence(text=["hi"], starts=[0.0], ends=[0.1])
    )

    # Act
    fake_session.emit(
        TranscriptionSessionInterface.TranscriptionResultEvent, result
    )

    # Assert
    assert received == [result]


def test_transcript_results_are_dropped_after_close(
    service: TranscriptionStreamService, fake_session: FakeSession
):
    """
    Late transcripts arriving from the underlying session after close are
    suppressed instead of being re-emitted to a controller that has already
    torn down.
    """
    # Arrange
    received: list[TranscriptionResult] = []
    service.on(
        TranscriptionStreamService.TranscriptionResultEvent, received.append
    )
    service.start()
    service.close()

    # Act
    fake_session.emit(
        TranscriptionSessionInterface.TranscriptionResultEvent,
        TranscriptionResult(),
    )

    # Assert
    assert not received


def test_transcription_errors_are_forwarded(
    service: TranscriptionStreamService, fake_session: FakeSession
):
    """
    Errors raised by the underlying session are re-emitted via
    TranscriptionErrorEvent so the controller can map them to close codes.
    """
    # Arrange
    received: list[Exception] = []
    service.on(
        TranscriptionStreamService.TranscriptionErrorEvent, received.append
    )
    service.start()
    error = TranscriptionClientError("bad chunk")

    # Act
    fake_session.emit(
        TranscriptionSessionInterface.TranscriptionErrorEvent, error
    )

    # Assert
    assert received == [error]
