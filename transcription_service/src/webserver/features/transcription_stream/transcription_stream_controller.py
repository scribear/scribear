"""
Defines TranscriptionStreamController that manages websocket connection for transcription streams
"""

import asyncio
from typing import Any

from pydantic import ValidationError
from starlette.websockets import WebSocket

from src.shared.config import Config
from src.shared.logger import Logger
from src.transcription_provider_interface import (
    TranscriptionClientError,
    TranscriptionResult,
    TranscriptionSessionInterface,
)
from src.webserver.shared.auth_service import AuthService
from src.webserver.shared.transcription_service import TranscriptionService
from src.webserver.shared.websocket_handler import WebsocketHandler

from .transcription_stream_messages import (
    ClientJsonMessageAdapter,
    ClientMessageTypes,
    FinalTranscriptMessage,
    IPTranscriptMessage,
)


class TranscriptionStreamController(WebsocketHandler):
    """
    Controller for /transcription_stream websocket
    Handles validating websocket messages schema and ordering

    - Auth message must be first to arrive
    - Config message must immediately follow Auth message
    - Socket closes after timeout if Auth and Config messages are not received
    """

    def __init__(
        self,
        config: Config,
        logger: Logger,
        auth_service: AuthService,
        transcription_service: TranscriptionService,
        provider_key: str,
        ws: WebSocket,
    ):
        """
        Args:
            config                  - Application config
            logger                  - Application logger
            auth_service            - Auth service instance
            transcription_service   - Transcription service instance
            provider_key            - Provider key requested by websocket
            ws                      - Websocket to manage
        """
        super().__init__(logger, ws)

        self._auth_service = auth_service
        self._transcription_service = transcription_service
        self._provider_key = provider_key
        self._session: TranscriptionSessionInterface | None = None

        self._is_authenticated = False
        self._timeout_task = asyncio.create_task(
            self._init_timeout(config.ws_init_timeout_sec)
        )

    async def _init_timeout(self, timeout: float):
        """
        AsyncIO task that closes websocket connection if authentication and
        configuration is not completed after timeout

        Args:
            timeout - Timeout length in seconds
        """
        await asyncio.sleep(timeout)
        if not self._is_authenticated:
            self.close(1008, "Auth Timeout")
        elif self._session is None:
            self.close(1008, "Config Timeout")

    def _auth(self, api_key: str):
        """
        Handles auth message

        Args:
            api_key - API key provided in message
        """
        if self._is_authenticated:
            self.close(1008, "Unexpected Auth Message")
            return

        if not self._auth_service.is_authenticated(api_key):
            self.close(1008, "Authentication Failed")
            return

        self._is_authenticated = True

    def _config(self, config: Any):
        """
        Handles config message

        Args:
            config  - config provided in message
        """
        if not self._is_authenticated or self._session is not None:
            self.close(1008, "Unexpected Config Message")
            return

        self._session = self._transcription_service.create_session(
            self._provider_key, config, self._logger
        )
        self._session.on(
            self._session.TranscriptionResultEvent,
            self._handle_transcription_result,
        )
        self._session.on(
            self._session.TranscriptionErrorEvent, self._handle_error
        )
        self._session.start_session()

    def _handle_transcription_result(self, result: TranscriptionResult):
        """
        Handles transcription result from transcription session

        Args:
            result  - Transcription result
        """
        if result.final is not None:
            self.send(
                FinalTranscriptMessage(
                    text=result.final.text,
                    starts=result.final.starts,
                    ends=result.final.ends,
                )
            )
        if result.in_progress is not None:
            self.send(
                IPTranscriptMessage(
                    text=result.in_progress.text,
                    starts=result.in_progress.starts,
                    ends=result.in_progress.ends,
                )
            )

    def _audio_chunk(self, chunk: bytes):
        """
        Handles audio chunk messages

        Args:
            chunk       - Audio chunk from client
        """
        if not self._is_authenticated:
            self.close(1008, "Audio chunk before authentication")
            return

        if not self._session:
            self.close(1008, "Audio chunk before configuration")
            return

        self._session.handle_audio_chunk(chunk)

    async def _handle_text_message(self, message: str):
        """
        Message handler that is called when a websocket receives a text message

        Args:
            message     - Text message received
        """
        parsed_message = ClientJsonMessageAdapter.validate_json(message)

        match parsed_message.type:
            case ClientMessageTypes.AUTH:
                self._auth(parsed_message.api_key)
            case ClientMessageTypes.CONFIG:
                self._config(parsed_message.config)

    async def _handle_binary_message(self, message: bytes):
        """
        Message handler that is called when a websocket receives a binary message

        Args:
            message     - Binary message received
        """
        self._audio_chunk(message)

    def _handle_close(self, code: int, reason: str | None):
        """
        Message handler that is called when a websocket closes

        Args:
            code        - Websocket close code
            reason      - Websocket close reason
        """
        self._timeout_task.cancel()
        if self._session is not None:
            self._session.end_session()

        self._logger.info(
            "Websocket closed", context={"code": code, "reason": reason}
        )

    def _handle_error(self, error: Exception) -> bool:
        """
        Message handler that is called when an error occurs when receiving or sending messages

        Args:
            error       - Exception to be handled

        Returns:
            True to prevent closing connection after handling error,
            False to automatically close websocket with code 1011 and reason "Internal Server Error"
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
