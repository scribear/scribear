"""
Defines FastAPI router for /transcription_stream websocket endpoint
"""

from fastapi import APIRouter
from starlette.websockets import WebSocket

from src.shared.config import Config
from src.shared.logger import Logger
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
):
    """
    Creates FastAPI router for /transcription_stream websocket endpoint

    Args:
        config              - Application config
        logger              - Application logger
        auth_service        - Auth service instance
        provider_registry   - Transcription provider registry instance
        metrics_registry    - In-memory telemetry store

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
        )

        await controller.receive_messages()

    return router
