"""
Defines FastAPI router for /healthcheck http endpoint
"""

from fastapi import APIRouter


def healthcheck_router():
    """
    Creates FastAPI router for /healthcheck http endpoint

    Returns:
        FastAPI router
    """
    router = APIRouter()

    @router.get("/healthcheck")
    async def healthcheck():
        return "ok"

    return router
