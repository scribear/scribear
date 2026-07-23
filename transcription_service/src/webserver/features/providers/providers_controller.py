"""
Defines ProvidersController that serves the provider health snapshot over HTTP
"""

from typing import Any

from src.webserver.shared.provider_health_snapshot import (
    ProviderHealthSnapshotService,
)


class ProvidersController:
    """
    Serves the `GET /providers/health` response body

    Transport only. The body itself is `ProviderHealthSnapshotService`'s, which
    the Redis telemetry publisher (B1.7 part 2) reads the same way this does -
    so the record on the fleet backplane and the one this endpoint returns are
    the same record, not two assemblies of it that can disagree.
    """

    def __init__(self, snapshots: ProviderHealthSnapshotService):
        """
        Args:
            snapshots   - Source of this host's provider health snapshot
        """
        self._snapshots = snapshots

    async def health(self) -> dict[str, Any]:
        """
        Gets the current per-provider health snapshot
        """
        return await self._snapshots.snapshot()
