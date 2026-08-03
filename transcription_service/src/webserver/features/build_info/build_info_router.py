"""
Defines FastAPI router for the /build-info http endpoint
"""

from fastapi import APIRouter

from .build_info_controller import read_build_info


def build_info_router():
    """
    Creates FastAPI router for the GET /build-info endpoint

    Which artifact this container was built from. Answered on the same path,
    with the same body, as every other container in the stack - the Node
    services get theirs from `createBaseServer`, the webapps and the reverse
    proxy ship theirs as a static file - so the admin console's Deployment
    Check can probe the whole stack with one loop.

    Unauthenticated, unlike /metrics/* and /providers/health, and for the same
    reason /probes/* is: nginx proxies nothing on this service to the outside,
    so the route is reachable only from inside the compose network, and the
    body names no provider, endpoint or key.

    The payload is read once, at registration: the environment it comes from is
    baked into the image and cannot change while the process lives.

    Returns:
        FastAPI router
    """
    router = APIRouter()
    build_info = read_build_info().to_json()

    @router.get("/build-info")
    async def get_build_info():
        return build_info

    return router
