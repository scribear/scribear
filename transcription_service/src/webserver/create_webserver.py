"""
Defines function that creates FastAPI webserver
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI

from src.shared.config import Config
from src.shared.logger import Logger
from src.shared.utils.worker_pool import (
    CapacityEstimator,
    JobExecutionObservation,
)

from .features.build_info import build_info_router
from .features.metrics import metrics_router
from .features.probes import probes_router
from .features.providers import providers_router
from .features.telemetry import (
    RedisSessionAudioPublisher,
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
    # PLAN-AdmissionControl.md §3/§4. Constructed here, next to
    # metrics_registry, because both are fed by the same job_observer below and
    # both are threaded onward the same way - the estimator now reaching the
    # provider registry (which enforces admission) as well as metrics_router
    # (which reports its snapshot).
    capacity_estimator = CapacityEstimator(
        target_busy=config.target_busy,
        min_sessions=config.min_sessions,
        max_sessions=config.max_sessions,
    )

    def _observe_job(observation: JobExecutionObservation) -> None:
        """
        Fans one completed job execution out to both consumers that need it:
        the metrics registry (what /metrics/status reports) and the capacity
        estimator (what decides whether the next session is admitted).
        """
        metrics_registry.record_job_execution(observation)
        capacity_estimator.record(observation)

    provider_registry = TranscriptionProviderRegistry(
        config, logger, _observe_job, capacity_estimator, metrics_registry
    )
    # One join, two consumers: the /providers/health route below and the
    # telemetry publisher started in the lifespan hook.
    provider_health_snapshots = ProviderHealthSnapshotService(
        provider_registry, process_identity, capacity_estimator
    )

    # Process-singleton, shared by every /transcription_stream connection -
    # not one per connection. Unlike the host-level publisher above this has
    # no beat to start (it is push-based, triggered by results arriving), so
    # it can be constructed here rather than inside the lifespan hook; the
    # `redis.asyncio` client it holds does not connect until its first
    # command, so nothing here needs a running event loop yet either. Off
    # entirely when no backplane is configured, same as the host publisher.
    audio_publisher = (
        RedisSessionAudioPublisher(
            create_telemetry_redis_client(config.redis_url),
            logger,
            config.transcription_host_id,
        )
        if config.redis_url
        else None
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

        if audio_publisher is not None:
            await audio_publisher.aclose()

        # Cleanup the provider registry (worker pool, providers) on app exit
        provider_registry.shutdown()

    app = FastAPI(lifespan=lifespan)

    app.include_router(probes_router(provider_registry))
    app.include_router(build_info_router())
    app.include_router(
        metrics_router(
            logger,
            metrics_auth_service,
            metrics_registry,
            provider_registry,
            capacity_estimator,
        )
    )
    app.include_router(
        providers_router(
            logger, metrics_auth_service, provider_health_snapshots
        )
    )
    app.include_router(
        transcription_stream_router(
            config,
            logger,
            auth_service,
            provider_registry,
            metrics_registry,
            audio_publisher,
        )
    )

    return app
