"""
Defines FastAPI router for the /metrics/* http endpoints
"""

from typing import Annotated

from fastapi import APIRouter, Header
from fastapi.responses import JSONResponse

from src.shared.logger import Logger
from src.webserver.shared.auth_service import MetricsAuthService
from src.webserver.shared.metrics import MetricsRegistry
from src.webserver.shared.transcription_provider_registry import (
    TranscriptionProviderRegistry,
)

from .metrics_controller import MetricsController


def metrics_router(
    logger: Logger,
    metrics_auth_service: MetricsAuthService,
    metrics_registry: MetricsRegistry,
    provider_registry: TranscriptionProviderRegistry,
):
    """
    Creates FastAPI router for the GET /metrics/status endpoint

    The route is registered only when a metrics key is configured, so an
    unconfigured deployment answers 404 rather than 401 - a switched-off
    endpoint should not look like a misconfigured credential.

    Args:
        logger                  - Application logger
        metrics_auth_service    - Auth service for the metrics key
        metrics_registry        - In-memory telemetry store
        provider_registry       - Owner of the worker pool and providers

    Returns:
        FastAPI router
    """
    router = APIRouter(prefix="/metrics")

    if not metrics_auth_service.is_enabled:
        logger.warning(
            "Metrics endpoint disabled: METRICS_API_KEY is unset. "
            "GET /metrics/status will return 404."
        )
        return router

    controller = MetricsController(metrics_registry, provider_registry)

    # Path is /metrics/status rather than a bare /metrics because a bare
    # /metrics reads as Prometheus text exposition to every operator and every
    # scraper, and this returns JSON. It also leaves /metrics free if a
    # Prometheus-text route is ever wanted here.
    @router.get("/status")
    async def status(authorization: Annotated[str | None, Header()] = None):
        if not metrics_auth_service.is_authenticated(authorization):
            # Deliberately does not distinguish absent from wrong: every
            # credential problem is one 401 with one body, so a consumer has a
            # single case to handle and a prober learns nothing.
            return JSONResponse(
                status_code=401,
                content={
                    "code": "INVALID_METRICS_KEY",
                    "message": (
                        "Missing or invalid metrics API key. Expected "
                        "'Authorization: Bearer <METRICS_API_KEY>'."
                    ),
                },
            )

        return controller.status()

    return router
