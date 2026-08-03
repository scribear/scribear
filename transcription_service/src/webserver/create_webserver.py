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
    # archived-plans/2026-07-27-02-PLAN-AdmissionControl.md §3/§4. Constructed
    # here, next to metrics_registry, because both are fed by the same
    # job_observer below and both are threaded onward the same way - to
    # metrics_router and ProviderHealthSnapshotService, which report its
    # snapshot. It is deliberately NOT threaded into the provider registry;
    # see the comment above that construction.
    capacity_estimator = CapacityEstimator(
        target_busy=config.target_busy,
        min_sessions=config.min_sessions,
        max_sessions=config.max_sessions,
    )

    def _observe_job(observation: JobExecutionObservation) -> None:
        """
        Fans one completed job execution out to both consumers that need it:
        the metrics registry (what /metrics/status reports) and the capacity
        estimator (whose ceiling both /metrics/status and /providers/health
        publish).
        """
        metrics_registry.record_job_execution(observation)
        capacity_estimator.record(observation)

    # SHADOW MODE: `None` where `capacity_estimator` would go, so the estimator
    # observes and reports but nothing is ever refused. Deliberate, and the one
    # thing that has to stay this way until a real deployment has been watched.
    #
    # Deferring job registration to a session's first audio chunk is
    # unambiguously correct on its own - an idle, audio-less connection no
    # longer takes a worker's job slot, which is what made refusals fire on
    # connection count rather than on load. But that same fix *lowers* the
    # measured ceiling, and by a lot. Idle registered jobs used to run an empty
    # batch every period (`worker_process.py`'s scheduling loop), which added a
    # distinct job_id to the estimator's window - inflating the `sessions`
    # denominator of `cost_per_session = busy / sessions`
    # (`capacity_estimator.py:_update_ratchet`) while contributing nothing to
    # the numerator. A live box measured `estimatedCapacitySessions: 50` under
    # that inflation. With it removed, a single whisper stream that keeps the
    # one worker busy for half of each 5000 ms period gives b ~ 0.5 and
    # therefore N* = 1.
    #
    # Turning enforcement on in the same change as the fix that moved the
    # number would mean shipping a ceiling nobody has observed under real load.
    # Wrong refusals are invisible to the user and unrecoverable for that
    # session, so the order is: measure first (the estimate is published on
    # /metrics/status and /providers/health, and drawn on the fleet dashboard),
    # then decide. Passing `capacity_estimator` here is the whole of the
    # switch - `_admits_worker` fails open on a `None` estimator by design.
    provider_registry = TranscriptionProviderRegistry(
        config, logger, _observe_job, None, metrics_registry
    )
    # One join, two consumers: the /providers/health route below and the
    # telemetry publisher started in the lifespan hook.
    provider_health_snapshots = ProviderHealthSnapshotService(
        provider_registry,
        process_identity,
        capacity_estimator,
        metrics_registry,
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
