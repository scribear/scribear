"""
Defines RedisTelemetryPublisher that publishes this host's provider health to
the fleet telemetry backplane
"""

import asyncio
import json
import time

from redis.asyncio import Redis

from src.shared.logger import Logger
from src.webserver.shared.provider_health_snapshot import (
    ProviderHealthSnapshotService,
)

from .telemetry_keys import (
    TRANSCRIPTION_HOST_HEARTBEAT_SEC,
    TRANSCRIPTION_HOST_INDEX_KEY,
    TRANSCRIPTION_HOST_TTL_MS,
    transcription_host_snapshot_key,
)


class RedisTelemetryPublisher:
    """
    Publishes this host's `/providers/health` body to Redis every heartbeat
    (B1.7 §2.4)

    **Why publish at all**, when the endpoint already serves the same body: a
    fleet runs several transcription hosts, and the dashboard's question -
    which providers are up anywhere, and how loaded are the workers behind them
    - is answered by all of them together. A reader fanning out over hosts
    would have to know how many there are, and could not tell a host it failed
    to reach from one with nothing running. Publishing inverts that: every host
    writes what it knows, and admin-server reads only Redis.

    **Liveness is expiry.** The snapshot is rewritten every beat under a TTL of
    five heartbeats and nothing here deletes anything, so a host that stops
    writing stops existing - which is what makes a crashed host leave the fleet
    view with no cleanup path to get wrong. The corollary is that a beat
    republishes the whole body whether or not it changed; this is a heartbeat,
    not a change feed.

    **It must never affect transcription.** Taking a snapshot reads in-memory
    state and cached probes only, every failure mode of the write is caught and
    logged, and no request path awaits any of it. Losing Redis costs the
    dashboard its cross-host view and costs a session nothing.
    """

    def __init__(
        self,
        redis_client: Redis,
        snapshots: ProviderHealthSnapshotService,
        logger: Logger,
        transcription_host_id: str,
    ):
        """
        Args:
            redis_client            - Connection to the telemetry backplane
            snapshots               - Source of this host's provider health
                                        snapshot, shared with the HTTP endpoint
            logger                  - Application logger
            transcription_host_id   - Identity this host publishes under,
                                        already validated to be ':'-free
        """
        self._redis = redis_client
        self._snapshots = snapshots
        self._logger = logger
        self._host_id = transcription_host_id

        self._task: asyncio.Task[None] | None = None
        # Latches once a failure has been logged and clears on the next
        # success, so an outage costs one warning rather than one every five
        # seconds. The recovery is logged too, which is what makes the pair
        # readable as a window.
        self._failure_logged = False

    def start(self) -> None:
        """
        Starts beating

        Must be called with the event loop running - the lifespan hook, where
        the task's lifetime is bounded by the app's.
        """
        if self._task is not None:
            return

        self._logger.info(
            "Publishing telemetry to the fleet backplane",
            context={
                "transcriptionHost": self._host_id,
                "heartbeatSec": TRANSCRIPTION_HOST_HEARTBEAT_SEC,
            },
        )
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        """
        Stops beating and closes the connection

        The key is deliberately left behind: it expires within seconds on its
        own, and deleting it would make a graceful restart look momentarily
        like a host that never existed, while a crash - which cannot delete
        anything - would not.
        """
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

        await self._redis.aclose()

    async def publish_once(self) -> None:
        """
        Publishes one beat: this host's snapshot, its index entry, and a prune
        of the index

        Exposed rather than private so tests can drive a beat deterministically
        instead of waiting on the heartbeat.
        """
        try:
            now = int(time.time() * 1000)
            record = {
                **await self._snapshots.snapshot(),
                # The envelope the contract adds on top of the endpoint's body:
                # who published it, and when by the publisher's own clock. The
                # timestamp is duplicated as the index score so a reader decides
                # staleness by comparing two integers.
                "transcriptionHost": self._host_id,
                "updatedAt": now,
            }

            # A pipeline, not a transaction: these writes have no invariant
            # between them a reader could observe being broken - each is an
            # idempotent overwrite of what the next beat writes again - so a
            # transaction would only buy blocking semantics nobody needs.
            beat = self._redis.pipeline(transaction=False)
            beat.set(
                transcription_host_snapshot_key(self._host_id),
                json.dumps(record),
                px=TRANSCRIPTION_HOST_TTL_MS,
            )
            beat.zadd(TRANSCRIPTION_HOST_INDEX_KEY, {self._host_id: now})
            # Sorted-set members carry no TTL of their own, so the index would
            # otherwise grow forever with the identity of every host the fleet
            # has ever run. Pruning is by score and therefore not scoped to this
            # host: whoever beats next drops whatever has expired, which is also
            # what clears a host that died without unregistering.
            beat.zremrangebyscore(
                TRANSCRIPTION_HOST_INDEX_KEY, 0, now - TRANSCRIPTION_HOST_TTL_MS
            )
            await beat.execute()

            if self._failure_logged:
                self._failure_logged = False
                self._logger.info("Telemetry publishing recovered")
        except Exception as error:  # pylint: disable=broad-exception-caught
            # Every failure here is the dashboard's problem, never a session's.
            # Redis down, misconfigured or slow, and a snapshot that raised,
            # all cost this host its place in the fleet view until it recovers
            # and nothing else.
            if not self._failure_logged:
                self._failure_logged = True
                self._logger.warning(
                    "Telemetry publish failed, this host will age out of the "
                    "fleet view until it recovers",
                    context={"error": str(error)},
                )

    async def _run(self) -> None:
        """
        Beats until cancelled

        Sleeps *after* each beat rather than on a fixed schedule, so a slow beat
        delays the next one instead of overlapping it. There is consequently no
        in-flight guard to get wrong: a beat that outran its period would only
        have rewritten the same keys with numbers the following beat rewrites
        again.
        """
        while True:
            await self.publish_once()
            await asyncio.sleep(TRANSCRIPTION_HOST_HEARTBEAT_SEC)
