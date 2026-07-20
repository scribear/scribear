"""
Defines TranscriptionStreamController that manages a single transcription
stream WebSocket connection. Owns framing, auth, and the auth -> config ->
audio message ordering; delegates session lifecycle to
TranscriptionStreamService.
"""

import asyncio

from pydantic import ValidationError
from starlette.websockets import WebSocket

from src.shared.config import Config
from src.shared.logger import Logger
from src.shared.utils.audio_frame_protocol import (
    AudioFrameError,
    decode_audio_frame,
)
from src.transcription_provider_interface import (
    TranscriptionClientError,
    TranscriptionResult,
)
from src.webserver.shared.auth_service import AuthService
from src.webserver.shared.metrics import MetricsRegistry
from src.webserver.shared.transcription_provider_registry import (
    TranscriptionProviderRegistry,
)
from src.webserver.shared.websocket_handler import WebsocketHandler

from .transcription_stream_messages import (
    ClientJsonMessageAdapter,
    ClientMessageTypes,
    TranscriptMessage,
    TranscriptSequence,
)
from .transcription_stream_service import TranscriptionStreamService


class TranscriptionStreamController(WebsocketHandler):
    """
    Controller for /transcription_stream websocket.

    Handles all protocol concerns:
      - validates incoming message schemas (auth, config, binary audio)
      - enforces the auth -> config -> audio ordering
      - runs the auth + config init timeout watchdog
      - maps thrown errors to WebSocket close codes
      - serializes transcripts emitted by the service onto the wire

    Auth verification (matching the configured API key) and session lifecycle
    management are delegated to {@link AuthService} and
    {@link TranscriptionStreamService} respectively, keeping this class free
    of business logic.
    """

    def __init__(
        self,
        config: Config,
        logger: Logger,
        auth_service: AuthService,
        provider_registry: TranscriptionProviderRegistry,
        metrics_registry: MetricsRegistry,
        provider_key: str,
        ws: WebSocket,
    ):
        """
        Args:
            config              - Application config
            logger              - Application logger
            auth_service        - Service used to verify the presented API key
            provider_registry   - Process-singleton provider registry
            metrics_registry    - Process-singleton telemetry store
            provider_key        - Provider key requested by websocket
            ws                  - Websocket to manage
        """
        super().__init__(logger, ws)

        self._auth_service = auth_service
        self._provider_registry = provider_registry
        self._metrics_registry = metrics_registry
        self._provider_key = provider_key

        self._service: TranscriptionStreamService | None = None
        self._is_authenticated = False
        self._timeout_task = asyncio.create_task(
            self._init_timeout(config.ws_init_timeout_sec)
        )

    async def _init_timeout(self, timeout: float):
        """
        Closes the websocket if authentication or configuration has not
        completed within the given timeout.
        """
        await asyncio.sleep(timeout)
        if not self._is_authenticated:
            self.close(1008, "Auth Timeout")
        elif self._service is None:
            self.close(1008, "Config Timeout")

    def _auth(self, api_key: str):
        """
        Handle the auth client message. Idempotent: a second auth message is
        treated as a protocol violation rather than re-authenticating.
        """
        if self._is_authenticated:
            self.close(1008, "Unexpected Auth Message")
            return

        if not self._auth_service.is_authenticated(api_key):
            self.close(1008, "Authentication Failed")
            return

        self._is_authenticated = True

    def _config(self, session_config: object):
        """
        Handle the config client message. Constructs the per-connection
        TranscriptionStreamService once auth has completed and a config has
        not yet been received.
        """
        if not self._is_authenticated or self._service is not None:
            self.close(1008, "Unexpected Config Message")
            return

        service = TranscriptionStreamService(
            self._logger,
            self._provider_registry,
            self._provider_key,
            session_config,
        )
        service.on(
            service.TranscriptionResultEvent, self._handle_transcription_result
        )
        service.on(service.TranscriptionErrorEvent, self._handle_error)
        service.start()
        self._service = service

    def _handle_transcription_result(self, result: TranscriptionResult):
        """
        Serialize a transcription result emitted by the service into a
        TranscriptMessage and send it over the websocket.
        """
        self.send(
            TranscriptMessage(
                final=(
                    TranscriptSequence(
                        text=result.final.text,
                        starts=result.final.starts,
                        ends=result.final.ends,
                    )
                    if result.final is not None
                    else None
                ),
                in_progress=(
                    TranscriptSequence(
                        text=result.in_progress.text,
                        starts=result.in_progress.starts,
                        ends=result.in_progress.ends,
                    )
                    if result.in_progress is not None
                    else None
                ),
                final_chunk_ids=result.final_chunk_ids or None,
                in_progress_chunk_ids=result.in_progress_chunk_ids or None,
            )
        )

    async def _handle_text_message(self, message: str):
        """
        Decode and route a text client message.
        """
        parsed_message = ClientJsonMessageAdapter.validate_json(message)

        match parsed_message.type:
            case ClientMessageTypes.AUTH:
                self._auth(parsed_message.api_key)
            case ClientMessageTypes.CONFIG:
                self._config(parsed_message.config)

    async def _handle_binary_message(self, message: bytes):
        """
        Treat any binary client message as a SAFP-framed chunk of source
        audio. Auth and config are enforced before the frame is decoded so an
        unauthenticated peer is rejected regardless of framing; a malformed
        frame from an authenticated peer is dropped (the node server already
        validated the CRC, so this is defense in depth).
        """
        if not self._is_authenticated:
            self.close(1008, "Audio chunk before authentication")
            return

        if self._service is None:
            self.close(1008, "Audio chunk before configuration")
            return

        try:
            frame = decode_audio_frame(message)
        except AudioFrameError:
            self._logger.warning("Dropping malformed audio frame")
            self._metrics_registry.record_decode_drop(self._provider_key)
            return

        self._service.handle_audio_chunk(frame.chunk_id or "", frame.audio)

    def _handle_close(self, code: int, reason: str | None):
        """
        Tear down the watchdog and any per-connection service on socket
        close.
        """
        self._timeout_task.cancel()
        if self._service is not None:
            self._service.close()

        self._logger.info(
            "Websocket closed", context={"code": code, "reason": reason}
        )

    def _handle_error(self, error: Exception) -> bool:
        """
        Map exceptions raised by either the websocket transport or the
        per-connection service into appropriate close codes.

        Returns:
            True to prevent the WebsocketHandler base from defaulting to
            close(1011, "Internal Server Error").
        """
        self._logger.warning(
            f"Websocket encountered error: {error}", exc_info=error
        )

        if isinstance(error, ValidationError):
            self.close(1007, "Invalid message format")
            return True

        if isinstance(error, TranscriptionClientError):
            self.close(1007, error.message)
            return True

        return False
