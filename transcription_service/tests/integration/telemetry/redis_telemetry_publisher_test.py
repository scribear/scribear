"""
Integration tests for fleet telemetry publishing, against a real Redis

Skipped unless REDIS_URL names a reachable server, which CI provides as a
service container. Everything asserted here is something a fake client cannot
answer: that the expiry actually lands on the key, that the score reads back
through a range query the way the reader will issue it, and that the prune
removes what an expired snapshot left behind in the index.
"""

import asyncio
import json
import logging
import os
from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient
from redis.asyncio import Redis

from src.shared.config import (
    Config,
    TranscriptionProviderConfigSchema,
    TranscriptionProviderUID,
)
from src.shared.logger import ContextLogger, Logger
from src.shared.utils.worker_pool import CapacityEstimator
from src.webserver.create_webserver import create_webserver
from src.webserver.features.telemetry import (
    RedisTelemetryPublisher,
    create_telemetry_redis_client,
)
from src.webserver.features.telemetry.telemetry_keys import (
    TRANSCRIPTION_HOST_INDEX_KEY,
    TRANSCRIPTION_HOST_TTL_MS,
    transcription_host_snapshot_key,
)
from src.webserver.shared.metrics import MetricsRegistry
from src.webserver.shared.process_identity import create_process_identity
from src.webserver.shared.provider_health_snapshot import (
    ProviderHealthSnapshotService,
)
from src.webserver.shared.transcription_provider_registry import (
    TranscriptionProviderRegistry,
)

REDIS_URL = os.environ.get("REDIS_URL", "")
HOST_ID = "integration-test-host"

# Real worker processes are spawned per test, which is well past the global 1s
# pytest timeout.
pytestmark = [
    pytest.mark.timeout(30),
    pytest.mark.skipif(
        not REDIS_URL, reason="REDIS_URL is unset; no backplane to publish to"
    ),
]

NUM_WORKERS = 1


@pytest.fixture
def mock_logger():
    """
    Create a mocked logger instance for testing
    """
    underlying_logger = MagicMock(spec=logging.Logger)
    underlying_logger.level = 10
    return ContextLogger(underlying_logger)


@pytest.fixture
def mock_config():
    """
    Create mock config object with telemetry publishing configured
    """
    mock = MagicMock(spec=Config)

    mock.api_key = "TEST_KEY"
    mock.metrics_api_key = "TEST_METRICS_KEY"
    mock.redis_url = REDIS_URL
    mock.transcription_host_id = HOST_ID
    mock.ws_init_timeout_sec = 1
    # Real numbers, not a MagicMock: create_webserver feeds these straight
    # into CapacityEstimator's ratchet, which does arithmetic on them the
    # moment a worker leaves warm-up.
    mock.target_busy = 0.85
    mock.min_sessions = 1
    mock.max_sessions = None
    mock.provider_config.num_workers = NUM_WORKERS
    mock.provider_config.contexts = []
    mock.provider_config.providers = {
        "debug": TranscriptionProviderConfigSchema(
            provider_uid=TranscriptionProviderUID.DEBUG, provider_config=None
        )
    }
    return mock


@pytest_asyncio.fixture
async def reader():
    """
    Create a Redis connection for reading back what the publisher wrote

    Separate from the publisher's own client on purpose: a read through the
    connection that did the write can be answered from the same pipeline, and
    the point here is that the *server* holds what the reader will find.
    """
    client = Redis.from_url(REDIS_URL)
    await client.delete(
        transcription_host_snapshot_key(HOST_ID), TRANSCRIPTION_HOST_INDEX_KEY
    )
    yield client
    await client.delete(
        transcription_host_snapshot_key(HOST_ID), TRANSCRIPTION_HOST_INDEX_KEY
    )
    await client.aclose()


@pytest_asyncio.fixture
async def publisher(mock_config: Config, mock_logger: Logger):
    """
    Create a publisher over a real provider registry and a real connection
    """
    capacity_estimator = CapacityEstimator(
        target_busy=mock_config.target_busy,
        min_sessions=mock_config.min_sessions,
        max_sessions=mock_config.max_sessions,
    )
    registry = TranscriptionProviderRegistry(
        mock_config, mock_logger, MagicMock(), capacity_estimator
    )
    instance = RedisTelemetryPublisher(
        create_telemetry_redis_client(REDIS_URL),
        ProviderHealthSnapshotService(
            registry,
            create_process_identity(),
            capacity_estimator,
            MetricsRegistry(),
        ),
        mock_logger,
        HOST_ID,
    )
    yield instance
    await instance.stop()
    registry.shutdown()


@pytest.mark.asyncio
async def test_snapshot_lands_with_an_expiry_on_it(
    publisher: RedisTelemetryPublisher, reader: Redis
):
    """
    Test the published key carries the contract's TTL

    Liveness is expiry: nothing deletes this key, so a host that stops beating
    has to disappear on its own. A write that landed without its expiry would
    leave a dead host in the fleet view forever, and only the server can say
    whether the expiry is really there.
    """
    # Act
    await publisher.publish_once()

    # Assert
    key = transcription_host_snapshot_key(HOST_ID)
    ttl_ms = await reader.pttl(key)
    assert 0 < ttl_ms <= TRANSCRIPTION_HOST_TTL_MS

    record = json.loads(await reader.get(key))
    assert record["transcriptionHost"] == HOST_ID
    assert record["numWorkers"] == NUM_WORKERS
    assert list(record["providers"]) == ["debug"]


@pytest.mark.asyncio
async def test_host_is_found_by_the_range_query_the_reader_will_issue(
    publisher: RedisTelemetryPublisher, reader: Redis
):
    """
    Test the index score reads back inside the reader's staleness window

    A reader must range the index from `now - TTL` rather than trust it whole,
    because sorted-set members have no expiry of their own. This is that query,
    and it is what proves the score is in the same unit as the window.
    """
    # Act
    await publisher.publish_once()

    # Assert
    record = json.loads(
        await reader.get(transcription_host_snapshot_key(HOST_ID))
    )
    live = await reader.zrangebyscore(
        TRANSCRIPTION_HOST_INDEX_KEY,
        record["updatedAt"] - TRANSCRIPTION_HOST_TTL_MS,
        "+inf",
    )
    assert live == [HOST_ID.encode()]

    scores = await reader.zscore(TRANSCRIPTION_HOST_INDEX_KEY, HOST_ID)
    assert scores == record["updatedAt"]


@pytest.mark.asyncio
async def test_a_beat_prunes_a_host_whose_snapshot_has_expired(
    publisher: RedisTelemetryPublisher, reader: Redis
):
    """
    Test the index does not accumulate hosts that stopped publishing

    The member outlives the snapshot it points at, so without a prune the index
    grows with the identity of every host the fleet has ever run - and pruning
    is by score rather than by host precisely so that whoever beats next clears
    a host that died without unregistering.
    """
    # Arrange - a host that last published two TTLs ago and never came back.
    await reader.zadd(TRANSCRIPTION_HOST_INDEX_KEY, {"long-dead-host": 1})

    # Act
    await publisher.publish_once()

    # Assert
    members = await reader.zrange(TRANSCRIPTION_HOST_INDEX_KEY, 0, -1)
    assert members == [HOST_ID.encode()]


@pytest.mark.asyncio
async def test_a_booted_server_publishes_without_being_asked(
    mock_config: Config, mock_logger: Logger, reader: Redis
):
    """
    Test the lifespan wiring, not just the publisher

    The first beat fires on startup rather than a heartbeat later, so a host
    that has just come up is in the fleet view immediately - and this is the
    only test that covers the path from `REDIS_URL` being set to a key existing.
    """
    # Act
    with TestClient(create_webserver(mock_config, mock_logger)):
        # Assert - the beat is a background task, so this waits for it rather
        # than for a heartbeat; a failure here times out on a key that never
        # arrives, which is the symptom the wiring being wrong would produce.
        payload = None
        for _ in range(100):
            payload = await reader.get(transcription_host_snapshot_key(HOST_ID))
            if payload is not None:
                break
            await asyncio.sleep(0.05)

    assert payload is not None
    assert json.loads(payload)["transcriptionHost"] == HOST_ID
