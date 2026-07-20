"""
Defines FastAPI router for the /providers/* http endpoints
"""

from typing import Annotated

from fastapi import APIRouter, Header

from src.shared.logger import Logger
from src.webserver.shared.auth_service import (
    MetricsAuthService,
    invalid_metrics_key_response,
)
from src.webserver.shared.process_identity import ProcessIdentity
from src.webserver.shared.transcription_provider_registry import (
    TranscriptionProviderRegistry,
)

from .providers_controller import ProvidersController


def providers_router(
    logger: Logger,
    metrics_auth_service: MetricsAuthService,
    provider_registry: TranscriptionProviderRegistry,
    process_identity: ProcessIdentity,
):
    """
    Creates FastAPI router for the GET /providers/health endpoint

    Guarded, unlike /probes/*, which are deliberately unauthenticated: this
    body names configured providers, upstream endpoints and worker layout, so
    it is internal detail rather than a load balancer's business.

    It reuses the metrics key rather than the API key the plan first sketched.
    They grant very different things - the API key opens transcription sessions
    and streams audio, this one only reads telemetry - and the consumers here
    are the monitoring sidecar and admin-server, exactly the least privileged
    components in the deployment. Sharing one secret would make a compromise of
    the monitoring path also grant the ability to open ASR sessions.

    Like /metrics/status, the route is registered only when a metrics key is
    configured, so an unconfigured deployment answers 404 rather than 401. The
    sidecar's poller already treats that 404 as "switched off at the far end"
    rather than as a transport fault.

    Args:
        logger                  - Application logger
        metrics_auth_service    - Auth service for the metrics key
        provider_registry       - Owner of the worker pool and providers
        process_identity        - Identity of this process run

    Returns:
        FastAPI router
    """
    router = APIRouter(prefix="/providers")

    if not metrics_auth_service.is_enabled:
        logger.warning(
            "Provider health endpoint disabled: METRICS_API_KEY is unset. "
            "GET /providers/health will return 404."
        )
        return router

    controller = ProvidersController(provider_registry, process_identity)

    @router.get("/health")
    async def health(authorization: Annotated[str | None, Header()] = None):
        if not metrics_auth_service.is_authenticated(authorization):
            return invalid_metrics_key_response()

        return await controller.health()

    return router
