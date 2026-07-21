"""
Defines function that creates FastAPI webserver
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI

from src.shared.config import Config
from src.shared.logger import Logger

from .features.metrics import metrics_router
from .features.probes import probes_router
from .features.providers import providers_router
from .features.telemetry import (
    RedisTelemetryPublisher,
    create_telemetry_redis_client,
)
from .features.transcription_stream import transcription_stream_router
from .shared.auth_service import AuthService, MetricsAuthService
from .shared.metrics import MetricsRegistry
from .shared.process_identity import create_process_identity
from .shared.provider_health_snapshot import ProviderHealthSnapshotService
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
    metrics_auth_service = MetricsAuthService(config)
    # One identity for the whole process, shared by every telemetry surface:
    # /metrics/status and /providers/health both report counters that reset on
    # restart, and a consumer can only correlate them if the uid matches.
    process_identity = create_process_identity()
    metrics_registry = MetricsRegistry(process_identity=process_identity)
    provider_registry = TranscriptionProviderRegistry(
        config, logger, metrics_registry.record_job_execution
    )
    # One join, two consumers: the /providers/health route below and the
    # telemetry publisher started in the lifespan hook.
    provider_health_snapshots = ProviderHealthSnapshotService(
        provider_registry, process_identity
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        """
        Mechanism for managing startup and shutdown of FastAPI
        This function is called before FastAPI starts responding to requests
        When FastAPI shuts down, we resume execution from the yield statement

        This is used to manage initializing and cleaning up resources
        """
        # Telemetry publishing is off unless a backplane is configured, and
        # when it is off nothing is constructed - so a deployment without Redis
        # opens no connection at all, rather than one that retries forever.
        # Both the client and its task are created here rather than above
        # because a task needs the running event loop, which only exists once
        # the app has started.
        telemetry_publisher = None
        if config.redis_url:
            telemetry_publisher = RedisTelemetryPublisher(
                create_telemetry_redis_client(config.redis_url),
                provider_health_snapshots,
                logger,
                config.transcription_host_id,
            )
            telemetry_publisher.start()
        else:
            logger.info(
                "Fleet telemetry publishing disabled: REDIS_URL is unset. "
                "This host will not appear in the dashboard's fleet view."
            )

        yield

        if telemetry_publisher is not None:
            await telemetry_publisher.stop()

        # Cleanup the provider registry (worker pool, providers) on app exit
        provider_registry.shutdown()

    app = FastAPI(lifespan=lifespan)

    app.include_router(probes_router(provider_registry))
    app.include_router(
        metrics_router(
            logger, metrics_auth_service, metrics_registry, provider_registry
        )
    )
    app.include_router(
        providers_router(
            logger, metrics_auth_service, provider_health_snapshots
        )
    )
    app.include_router(
        transcription_stream_router(
            config, logger, auth_service, provider_registry, metrics_registry
        )
    )

    return app
