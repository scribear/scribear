"""
Defines FastAPI router for the /metrics/* http endpoints
"""

from typing import Annotated

from fastapi import APIRouter, Header

from src.shared.logger import Logger
from src.shared.utils.worker_pool import CapacityEstimator
from src.webserver.shared.auth_service import (
    MetricsAuthService,
    invalid_metrics_key_response,
)
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
    capacity_estimator: CapacityEstimator,
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
        capacity_estimator      - Shadow-mode per-worker capacity estimator
                                    (archived-plans/2026-07-27-02-PLAN-AdmissionControl.md
                                    §3)

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

    controller = MetricsController(
        metrics_registry, provider_registry, capacity_estimator
    )

    # Path is /metrics/status rather than a bare /metrics because a bare
    # /metrics reads as Prometheus text exposition to every operator and every
    # scraper, and this returns JSON. It also leaves /metrics free if a
    # Prometheus-text route is ever wanted here.
    @router.get("/status")
    async def status(authorization: Annotated[str | None, Header()] = None):
        if not metrics_auth_service.is_authenticated(authorization):
            return invalid_metrics_key_response()

        return controller.status()

    return router
