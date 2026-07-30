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
        # Separate from `_closed`: that flag also gates whether `close()` still
        # has teardown to do, and a chunk error must not skip that teardown -
        # `end_session()` is what balances the `session_started()` this
        # session's constructor already ran, so skipping it would leak the
        # provider's active-session count for good. This only stops
        # `handle_audio_chunk` from re-entering a session that has already
        # raised once.
        self._audio_chunk_failed = False

    def start(self):
        """
        Create the underlying transcription session, register transcript /
        error forwarders, and start the session. Raises
        TranscriptionClientError if the provider key is unknown; callers
        should treat that as a protocol-level (1007) close.

        Never raises TranscriptionCapacityError - that used to be decided
        here, synchronously, but a session's job (and therefore the worker it
        would occupy) is no longer registered at construction. It registers on
        the session's own first `handle_audio_chunk`, which is also where a
        capacity refusal now surfaces (PLAN-AdmissionControl.md §4; see
        handle_audio_chunk below and TranscriptionSessionInterface for why).
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

        A session's first chunk can be the one that registers its worker-pool
        job and finds out - right then - that the worker is at capacity
        (PLAN-AdmissionControl.md §4; job registration is deferred to first
        audio, see TranscriptionSessionInterface). That raises
        TranscriptionCapacityError out of this call, same as any other session
        error, and this latches `_audio_chunk_failed` before re-raising: the
        socket close that error triggers is asynchronous, so more chunks can
        arrive before it lands, and without the latch each one would retry
        registration against the same full worker and log another refusal for
        a connection that is already on its way out. Deliberately not
        `_closed` - `close()` still has to run its teardown once the socket
        actually disconnects, whatever happened here.
        """
        if self._closed or self._session is None or self._audio_chunk_failed:
            return
        try:
            self._session.handle_audio_chunk(chunk_id, chunk)
        # pylint: disable=broad-exception-caught
        except Exception:
            self._audio_chunk_failed = True
            raise

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
