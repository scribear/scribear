"""
Defines FastAPI router for /probes/* http endpoints
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from src.webserver.features.probes.probes_controller import evaluate_readiness
from src.webserver.shared.transcription_provider_registry import (
    TranscriptionProviderRegistry,
)


def probes_router(provider_registry: TranscriptionProviderRegistry):
    """
    Creates FastAPI router for /probes/liveness and /probes/readiness endpoints

    Args:
        provider_registry - Registry owning the worker pool being reported on

    Returns:
        FastAPI router
    """
    router = APIRouter(prefix="/probes")

    @router.get("/liveness")
    async def liveness():
        return {"status": "ok"}

    @router.get("/readiness")
    async def readiness():
        # Until B1.3 this was a hard-coded 200: the service blocks on worker
        # pool initialization during startup, so "accepting requests" was taken
        # to mean "ready". That missed the failure that actually matters - a
        # worker that dies *after* startup - because nothing else notices.
        report = evaluate_readiness(provider_registry.worker_snapshots())

        if not report.ready:
            return JSONResponse(
                status_code=503,
                content={"status": "fail", "checks": report.checks},
            )

        if report.degraded:
            return JSONResponse(
                status_code=200,
                content={"status": "degraded", "checks": report.checks},
            )

        return JSONResponse(status_code=200, content={"status": "ok"})

    return router
