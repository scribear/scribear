"""
Defines FastAPI router for /transcription_stream websocket endpoint
"""

# This router's construction call necessarily mirrors create_webserver.py's
# call into it - both forward the same process-singleton dependencies in the
# same order.
# pylint: disable=duplicate-code

from fastapi import APIRouter
from starlette.websockets import WebSocket

from src.shared.config import Config
from src.shared.logger import Logger
from src.webserver.features.telemetry import RedisSessionAudioPublisher
from src.webserver.shared.auth_service import AuthService
from src.webserver.shared.metrics import MetricsRegistry
from src.webserver.shared.transcription_provider_registry import (
    TranscriptionProviderRegistry,
)

from .transcription_stream_controller import TranscriptionStreamController


def transcription_stream_router(
    config: Config,
    logger: Logger,
    auth_service: AuthService,
    provider_registry: TranscriptionProviderRegistry,
    metrics_registry: MetricsRegistry,
    audio_publisher: RedisSessionAudioPublisher | None,
):
    """
    Creates FastAPI router for /transcription_stream websocket endpoint

    Args:
        config              - Application config
        logger              - Application logger
        auth_service        - Auth service instance
        provider_registry   - Transcription provider registry instance
        metrics_registry    - In-memory telemetry store
        audio_publisher      - Process-singleton publisher of per-session
                                 audio-level stats to the fleet telemetry
                                 backplane, or None when no backplane is
                                 configured

    Returns:
        FastAPI router
    """
    router = APIRouter()

    @router.websocket("/transcription_stream/{provider_key}")
    async def transcription_stream(ws: WebSocket, provider_key: str):
        controller = TranscriptionStreamController(
            config,
            logger,
            auth_service,
            provider_registry,
            metrics_registry,
            provider_key,
            ws,
            audio_publisher,
        )

        await controller.receive_messages()

    return router
