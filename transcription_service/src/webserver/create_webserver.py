"""
Defines function that creates FastAPI webserver
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI

from src.shared.config import Config
from src.shared.logger import Logger

from .features.probes import probes_router
from .features.transcription_stream import transcription_stream_router
from .shared.auth_service import AuthService
from .shared.transcription_provider_registry import (
    TranscriptionProviderRegistry,
)


def create_webserver(config: Config, logger: Logger):
    """
    Creates FastAPI webserver

    Args:
        config  - Application config
        logger  - Application logger

    Returns:
        FastAPI instance
    """

    auth_service = AuthService(config)
    provider_registry = TranscriptionProviderRegistry(config, logger)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        """
        Mechanism for managing startup and shutdown of FastAPI
        This function is called before FastAPI starts responding to requests
        When FastAPI shuts down, we resume execution from the yield statement

        This is used to manage initializing and cleaning up resources
        """
        # Nothing to set up

        yield

        # Cleanup the provider registry (worker pool, providers) on app exit
        provider_registry.shutdown()

    app = FastAPI(lifespan=lifespan)

    app.include_router(probes_router())
    app.include_router(
        transcription_stream_router(
            config, logger, auth_service, provider_registry
        )
    )

    return app
