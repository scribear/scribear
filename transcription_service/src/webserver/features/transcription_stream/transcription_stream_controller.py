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
    TranscriptionCapacityError,
    TranscriptionClientError,
    TranscriptionResult,
)
from src.webserver.features.telemetry import (
    RedisSessionAudioPublisher,
    SessionAudioTracker,
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
        audio_publisher: RedisSessionAudioPublisher | None = None,
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
            audio_publisher      - Process-singleton publisher of per-session
                                     audio-level stats, or None when no
                                     telemetry backplane is configured
        """
        super().__init__(logger, ws)

        self._auth_service = auth_service
        self._provider_registry = provider_registry
        self._metrics_registry = metrics_registry
        self._provider_key = provider_key
        self._audio_publisher = audio_publisher
        # Per-connection, and built even when no backplane is configured: the
        # tracker is where the "was any audio metered" answer lives, and making
        # it conditional would put a `None` check on the per-chunk path to save
        # an object per session.
        self._audio_tracker = SessionAudioTracker(
            logger, config.audio_silence_threshold
        )

        self._service: TranscriptionStreamService | None = None
        self._is_authenticated = False
        self._session_uid: str | None = None
        self._room_uid: str | None = None
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

    def _config(
        self,
        session_config: object,
        session_uid: str | None,
        room_uid: str | None,
    ):
        """
        Handle the config client message. Constructs the per-connection
        TranscriptionStreamService once auth has completed and a config has
        not yet been received.

        Capacity admission (archived-plans/2026-07-27-02-PLAN-AdmissionControl.md
        §4) no longer happens here: a session's worker-pool job registers on
        its own first audio chunk, not at construction, so there is nothing to
        ask about yet. `TranscriptionCapacityError` instead surfaces from
        `_handle_binary_message` below, and is mapped to a 1013 close by the
        same `_handle_error` this method's own errors go through - deliberately
        not the WebSocket handshake, which is unconditional before anything
        about the session is known, and deliberately gated behind auth so an
        unauthenticated peer can neither consume capacity nor learn anything
        about it.
        """
        if not self._is_authenticated or self._service is not None:
            self.close(1008, "Unexpected Config Message")
            return

        self._session_uid = session_uid
        self._room_uid = room_uid

        service = TranscriptionStreamService(
            self._logger,
            self._provider_registry,
            self._provider_key,
            session_config,
            session_uid,
            room_uid,
        )
        service.on(
            service.TranscriptionResultEvent, self._handle_transcription_result
        )
        service.on(service.TranscriptionResultEvent, self._handle_audio_stages)
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

    def _handle_audio_stages(self, result: TranscriptionResult):
        """
        Record the audio measurement points a result reports, and publish the
        session's graph

        A second listener on the same event `_handle_transcription_result`
        subscribes to, kept separate rather than folded into that handler:
        WS-serialization and telemetry-publishing are independent concerns
        that happen to react to the same event, matching this codebase's
        existing separation between a join (`ProviderHealthSnapshotService`)
        and its publisher.

        Deliberately not guarded on the result carrying any reading. It used to
        early-return when the provider reported no stats, which meant `debug`
        and `lumen_granite` deployments published nothing at all and every
        healthy session on them showed a red audio chip (§12.1). Ingress
        telemetry now exists for every provider, so an empty
        `result.audio_stages` is a provider that measures nothing - not a
        session with no audio telemetry.
        """
        self._audio_tracker.record_provider_stages(result.audio_stages)
        self._publish_audio_stages()

    def _publish_audio_stages(self):
        """
        Publish this session's audio-telemetry graph if a write is due

        `is_due` is asked *before* the payload is assembled, because assembling
        it costs an `AudioMeter.snapshot()` - ~218 us against ~29 us to meter a
        chunk, and chunks arrive ~10/s (§12.9). Gating on the publisher's own
        predicate rather than a timer here keeps the interval defined in one
        place: a second timer in the controller would drift from the
        publisher's and either starve the dashboard or pay the snapshot cost
        for a write that gets dropped anyway.

        An empty stage list is not published: nothing has been measured yet, so
        there is no snapshot to make, and skipping leaves the throttle window
        open for the first real reading rather than consuming it on a payload
        with no numbers in it.
        """
        if self._audio_publisher is None:
            return
        if not self._audio_publisher.is_due(self._session_uid):
            return

        stages = self._audio_tracker.resolved_stages()
        if not stages:
            return

        self._audio_publisher.publish(self._session_uid, self._room_uid, stages)

    async def _handle_text_message(self, message: str):
        """
        Decode and route a text client message.
        """
        parsed_message = ClientJsonMessageAdapter.validate_json(message)

        match parsed_message.type:
            case ClientMessageTypes.AUTH:
                self._auth(parsed_message.api_key)
            case ClientMessageTypes.CONFIG:
                self._config(
                    parsed_message.config,
                    parsed_message.session_uid,
                    parsed_message.room_uid,
                )

    async def _handle_binary_message(self, message: bytes):
        """
        Treat any binary client message as a SAFP-framed chunk of source
        audio. Auth and config are enforced before the frame is decoded so an
        out-of-order frame never reaches a session; a malformed frame from an
        authenticated, configured peer is dropped separately below (the node
        server already validated the CRC, so this is defense in depth).

        A frame that arrives before auth, or before config, is dropped and
        counted rather than closing the socket - mirroring the fix already
        applied on the node-server side (see
        `transcription-stream.controller.ts`'s `socket.on('message', ...)`
        handler). Closing here turns a recoverable client bug into a silent
        reconnect loop: a source that starts streaming before AUTH_OK (or
        before its CONFIG has been processed) would be closed 1008, the
        client's auto-reconnect immediately re-sends AUTH, its first chunk
        again beats AUTH_OK, and the cycle repeats forever with no audio ever
        delivered and nothing naming the cause. The frame is worthless here
        regardless - there is no session yet to hand it to - so dropping it is
        strictly the better failure mode: the socket stays open long enough to
        finish auth/config, after which audio flows normally. The init-timeout
        watchdog (`_init_timeout`) still closes a socket that never completes
        the handshake at all.
        """
        if not self._is_authenticated:
            self._metrics_registry.record_binary_dropped_before_auth(
                self._provider_key
            )
            self._logger.debug(
                "Dropping binary frame received before authentication",
                context={"provider_key": self._provider_key},
            )
            return

        if self._service is None:
            self._metrics_registry.record_binary_dropped_before_config(
                self._provider_key
            )
            self._logger.debug(
                "Dropping binary frame received before configuration",
                context={"provider_key": self._provider_key},
            )
            return

        try:
            frame = decode_audio_frame(message)
        except AudioFrameError:
            self._logger.warning("Dropping malformed audio frame")
            self._metrics_registry.record_decode_drop(self._provider_key)
            return

        # Metered here rather than in the provider, and before the chunk is
        # handed on: this is the last point that is the same for every provider
        # and the only one a stalled model or an unreachable upstream cannot
        # affect, which is what makes the audio chip a second axis rather than
        # a restatement of connectivity (D1 / §12.1).
        self._audio_tracker.meter_chunk(frame.audio, frame.stage_depth)
        self._publish_audio_stages()

        self._service.handle_audio_chunk(frame.chunk_id or "", frame.audio)

    def _handle_close(self, code: int, reason: str | None):
        """
        Tear down the watchdog and any per-connection service on socket
        close.
        """
        self._timeout_task.cancel()
        if self._service is not None:
            self._service.close()
        if self._audio_publisher is not None:
            self._audio_publisher.forget(self._session_uid)

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

        # Before the TranscriptionClientError branch, and a separate type
        # rather than a subclass of it, because 1007 ("invalid frame payload
        # data") is the misattribution PR #171 removed: it blames the client
        # for the service being busy. 1013 ("Try Again Later") is the IANA
        # registry's code for exactly this, and the reason string is what lets
        # the node server report "refused" rather than "crashed"
        # (archived-plans/2026-07-27-02-PLAN-AdmissionControl.md §4).
        if isinstance(error, TranscriptionCapacityError):
            self.close(1013, error.message)
            return True

        if isinstance(error, TranscriptionClientError):
            self.close(1007, error.message)
            return True

        return False
