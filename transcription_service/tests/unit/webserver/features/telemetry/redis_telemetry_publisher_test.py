"""
Unit tests for RedisTelemetryPublisher
"""

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from freezegun import freeze_time

from src.shared.logger import ContextLogger
from src.webserver.features.telemetry import RedisTelemetryPublisher
from src.webserver.features.telemetry.telemetry_keys import (
    TRANSCRIPTION_HOST_INDEX_KEY,
    TRANSCRIPTION_HOST_TTL_MS,
)
from src.webserver.shared.provider_health_snapshot import (
    ProviderHealthSnapshotService,
)

HOST_ID = "transcription-service-1"
SNAPSHOT_KEY = f"scribe:v1:ts:{HOST_ID}"

# Any instant works; it is frozen so the record's `updatedAt`, the index score
# and the prune bound can be asserted against one another exactly.
NOW = "2026-07-21T12:00:00Z"
NOW_MS = 1784635200000

BODY: dict[str, Any] = {
    "processUid": "11111111-2222-3333-4444-555555555555",
    "processStartedAt": "2026-07-21T11:00:00+00:00",
    "numWorkers": 2,
    "invalidProviderKeyRejects": 3,
    "workers": [],
    "providers": {},
}


class FakePipeline:
    """
    Records the commands a beat buffers, and fails execution on demand
    """

    def __init__(
        self, commands: list[tuple[Any, ...]], error: Exception | None
    ):
        self.commands = commands
        self._error = error

    def set(self, key: str, value: str, px: int | None = None):
        """
        Records a SET
        """
        self.commands.append(("set", key, value, px))
        return self

    def zadd(self, key: str, mapping: dict[str, float]):
        """
        Records a ZADD
        """
        self.commands.append(("zadd", key, mapping))
        return self

    def zremrangebyscore(self, key: str, min_score: float, max_score: float):
        """
        Records a ZREMRANGEBYSCORE
        """
        self.commands.append(("zremrangebyscore", key, min_score, max_score))
        return self

    async def execute(self):
        """
        Executes the buffered commands, raising if this beat is meant to fail
        """
        if self._error is not None:
            raise self._error
        return [True] * len(self.commands)


class FakeRedis:
    """
    Minimal stand-in for the telemetry Redis client
    """

    def __init__(self):
        self.commands: list[tuple[Any, ...]] = []
        self.transaction_flags: list[bool] = []
        self.closed = False
        self.error: Exception | None = None

    def pipeline(self, transaction: bool = True):
        """
        Opens a pipeline, recording whether it was asked to be transactional
        """
        self.transaction_flags.append(transaction)
        return FakePipeline(self.commands, self.error)

    async def aclose(self):
        """
        Closes the connection
        """
        self.closed = True


def _publisher(
    redis_client: FakeRedis, snapshot: dict[str, Any] | Exception | None = None
):
    """
    Builds a publisher over a snapshot service returning the given body

    Args:
        redis_client    - Fake backplane connection
        snapshot        - Body to return, or an exception to raise instead;
                            defaults to BODY
    """
    snapshots = MagicMock(spec=ProviderHealthSnapshotService)
    if isinstance(snapshot, Exception):
        snapshots.snapshot = AsyncMock(side_effect=snapshot)
    else:
        snapshots.snapshot = AsyncMock(return_value=snapshot or BODY)

    logger = MagicMock(spec=ContextLogger)

    return (
        RedisTelemetryPublisher(redis_client, snapshots, logger, HOST_ID),
        logger,
    )


@pytest.mark.asyncio
@freeze_time(NOW)
async def test_publishes_the_health_body_under_this_hosts_key():
    """
    Test a beat writes the endpoint's body verbatim, plus the envelope

    The published record and the HTTP body come from one join on purpose; a
    reader that has parsed one must not have to learn a second spelling of it.
    """
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client)

    # Act
    await publisher.publish_once()

    # Assert
    command, key, value, px = redis_client.commands[0]
    assert (command, key) == ("set", SNAPSHOT_KEY)
    assert json.loads(value) == {
        **BODY,
        "transcriptionHost": HOST_ID,
        "updatedAt": NOW_MS,
    }
    assert px == TRANSCRIPTION_HOST_TTL_MS


@pytest.mark.asyncio
@freeze_time(NOW)
async def test_indexes_this_host_at_the_records_own_timestamp():
    """
    Test the index score is the record's `updatedAt`, in the same unit

    A reader decides staleness by comparing the score it ranged on with the
    field it parsed; the two disagreeing would make a live host read as stale
    or the reverse.
    """
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client)

    # Act
    await publisher.publish_once()

    # Assert
    assert redis_client.commands[1] == (
        "zadd",
        TRANSCRIPTION_HOST_INDEX_KEY,
        {HOST_ID: NOW_MS},
    )


@pytest.mark.asyncio
@freeze_time(NOW)
async def test_prunes_the_index_of_everything_older_than_the_ttl():
    """
    Test every beat drops expired members from the index

    Sorted-set members carry no TTL of their own, so without this the index
    accumulates the identity of every host the fleet has ever run - including
    hosts whose snapshots expired long ago. Pruning is by score, not by host,
    which is also what clears a host that died without unregistering.
    """
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client)

    # Act
    await publisher.publish_once()

    # Assert
    assert redis_client.commands[2] == (
        "zremrangebyscore",
        TRANSCRIPTION_HOST_INDEX_KEY,
        0,
        NOW_MS - TRANSCRIPTION_HOST_TTL_MS,
    )


@pytest.mark.asyncio
async def test_beats_without_a_transaction():
    """
    Test the beat is a pipeline, not a MULTI

    The writes have no invariant between them a reader could observe being
    broken - each is an idempotent overwrite of what the next beat writes
    again - so a transaction would only buy blocking semantics nobody needs.
    """
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client)

    # Act
    await publisher.publish_once()

    # Assert
    assert redis_client.transaction_flags == [False]


@pytest.mark.asyncio
async def test_a_failed_beat_never_escapes():
    """
    Test a Redis failure is swallowed rather than raised

    Nothing awaits a beat, but the task running them must survive one: an
    unhandled failure would end the loop and this host would never publish
    again, which reads as a dead host rather than an unreachable Redis.
    """
    # Arrange
    redis_client = FakeRedis()
    redis_client.error = ConnectionError("connection refused")
    publisher, _ = _publisher(redis_client)

    # Act / Assert
    await publisher.publish_once()


@pytest.mark.asyncio
async def test_a_failed_snapshot_never_escapes():
    """
    Test a snapshot that raises is caught like a failed write

    Provider health is assembled from live registries; a provider raising while
    describing itself must cost this host its place in the fleet view and
    nothing more.
    """
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client, RuntimeError("provider exploded"))

    # Act
    await publisher.publish_once()

    # Assert
    assert not redis_client.commands


@pytest.mark.asyncio
async def test_logs_one_warning_per_outage_and_one_line_on_recovery():
    """
    Test the failure log latches until the next successful beat

    At a beat every five seconds an unlatched warning turns a Redis outage into
    a log flood, which buries the one line that explains it.
    """
    # Arrange
    redis_client = FakeRedis()
    redis_client.error = ConnectionError("connection refused")
    publisher, logger = _publisher(redis_client)

    # Act
    await publisher.publish_once()
    await publisher.publish_once()
    redis_client.error = None
    await publisher.publish_once()
    await publisher.publish_once()

    # Assert
    assert logger.warning.call_count == 1
    assert logger.info.call_count == 1

    # And a second outage is reported again, rather than being latched forever.
    redis_client.error = ConnectionError("connection refused")
    await publisher.publish_once()
    assert logger.warning.call_count == 2


@pytest.mark.asyncio
async def test_start_beats_immediately_and_stop_closes_the_connection():
    """
    Test the first beat does not wait a heartbeat, and shutdown tears down

    Unlike the Node Server publisher, which must wait for its client to signal
    `ready`, `redis.asyncio` establishes the connection inside the first
    command - so there is no window in which an immediate beat fails merely
    because connecting has not finished.
    """
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client)

    # Act
    publisher.start()
    # Let the task reach its first await on the heartbeat sleep.
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    beat_count = len(redis_client.commands)
    await publisher.stop()

    # Assert
    assert beat_count == 3
    assert redis_client.closed


@pytest.mark.asyncio
async def test_stopping_a_publisher_that_never_started_still_closes_it():
    """
    Test shutdown is safe whether or not a beat ever ran
    """
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client)

    # Act
    await publisher.stop()

    # Assert
    assert redis_client.closed
