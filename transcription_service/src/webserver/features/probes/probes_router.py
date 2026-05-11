"""
Defines FastAPI router for /probes/* http endpoints
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse


def probes_router():
    """
    Creates FastAPI router for /probes/liveness and /probes/readiness endpoints

    Returns:
        FastAPI router
    """
    router = APIRouter(prefix="/probes")

    @router.get("/liveness")
    async def liveness():
        return {"status": "ok"}

    @router.get("/readiness")
    async def readiness():
        # The service blocks on worker pool initialization in the lifespan
        # startup, so by the time we are accepting requests there are no
        # additional readiness gates to evaluate. The 503 branch is kept in
        # the schema for future signals (e.g. provider warmup state).
        return JSONResponse(status_code=200, content={"status": "ok"})

    return router
