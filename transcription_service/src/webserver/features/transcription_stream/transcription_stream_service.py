"""
Defines TranscriptionStreamService - per-connection business logic for the
transcription stream WebSocket. Transport- and auth-agnostic; the controller
handles framing, auth, and message ordering and delegates the session
lifecycle to this class.
"""

from typing import Any

from src.shared.logger import Logger
from src.shared.utils.event_emitter import Event, EventEmitter
from src.transcription_provider_interface import (
    TranscriptionClientError,
    TranscriptionResult,
    TranscriptionSessionInterface,
)
from src.webserver.shared.transcription_provider_registry import (
    TranscriptionProviderRegistry,
)


class TranscriptionStreamService(EventEmitter):
    """
    Owns one transcription session for the duration of a single connection.

    Lifecycle:
      - `start()` resolves the requested provider, opens a session, and wires
        the session's transcript/error events through to this emitter.
      - `handle_audio_chunk(chunk)` forwards audio to the underlying session.
      - `close()` tears the session down.

    The class has no knowledge of WebSocket framing or auth - the controller
    is responsible for gating audio chunks behind a successful handshake and
    for serializing emitted transcripts onto the wire.
    """

    TranscriptionResultEvent = Event[TranscriptionResult](
        "TRANSCRIPTION_RESULT"
    )
    TranscriptionErrorEvent = Event[TranscriptionClientError | Exception](
        "TRANSCRIPTION_ERROR"
    )

    def __init__(
        self,
        logger: Logger,
        provider_registry: TranscriptionProviderRegistry,
        provider_key: str,
        session_config: Any,
        session_uid: str | None = None,
        room_uid: str | None = None,
    ):
        """
        Args:
            logger              - Logger to hand to the underlying session
            provider_registry   - Process-singleton provider registry
            provider_key        - Provider key requested by the caller
            session_config      - Session configuration payload from the caller
            session_uid         - Opaque session identifier from the caller,
                                    if known
            room_uid            - Opaque room identifier from the caller, if
                                    known
        """
        super().__init__()
        self._logger = logger
        self._provider_registry = provider_registry
        self._provider_key = provider_key
        self._session_config = session_config
        self._session_uid = session_uid
        self._room_uid = room_uid
        self._session: TranscriptionSessionInterface | None = None
        self._closed = False

    def start(self):
        """
        Create the underlying transcription session, register transcript /
        error forwarders, and start the session. Raises
        TranscriptionClientError if the provider key is unknown; callers
        should treat that as a protocol-level (1007) close.
        """
        self._session = self._provider_registry.create_session(
            self._provider_key,
            self._session_config,
            self._session_uid,
            self._room_uid,
            self._logger,
        )
        self._session.on(
            self._session.TranscriptionResultEvent, self._handle_session_result
        )
        self._session.on(
            self._session.TranscriptionErrorEvent, self._handle_session_error
        )
        self._session.start_session()

    def handle_audio_chunk(self, chunk_id: str, chunk: bytes):
        """
        Forward an audio chunk to the underlying session. No-op if the
        service has been closed.
        """
        if self._closed or self._session is None:
            return
        self._session.handle_audio_chunk(chunk_id, chunk)

    def close(self):
        """
        End the underlying session and stop forwarding events.
        """
        if self._closed:
            return
        self._closed = True
        if self._session is not None:
            self._session.end_session()
            self._session = None

    def _handle_session_result(self, result: TranscriptionResult):
        if self._closed:
            return
        self.emit(self.TranscriptionResultEvent, result)

    def _handle_session_error(
        self, error: TranscriptionClientError | Exception
    ):
        if self._closed:
            return
        self.emit(self.TranscriptionErrorEvent, error)
