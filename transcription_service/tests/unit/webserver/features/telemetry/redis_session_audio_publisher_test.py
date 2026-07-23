"""
Unit tests for RedisSessionAudioPublisher
"""

import asyncio
import json
from typing import Any
from unittest.mock import MagicMock

import pytest
from freezegun import freeze_time

from src.shared.logger import ContextLogger
from src.shared.utils.audio_meter import AudioLevelStats
from src.transcription_provider_interface import VadStats
from src.webserver.features.telemetry import RedisSessionAudioPublisher
from src.webserver.features.telemetry.telemetry_keys import (
    AUDIO_STATS_TTL_MS,
    TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
)

SESSION_UID = "session-1"
ROOM_UID = "room-1"
SNAPSHOT_KEY = f"scribe:v1:audio:{SESSION_UID}"

NOW = "2026-07-21T12:00:00Z"
NOW_MS = 1784635200000

STATS = AudioLevelStats(
    rms_dbfs=-20.0,
    peak_dbfs=-10.0,
    clipping_pct=0.0,
    silence=False,
    noise_floor_dbfs=-45.0,
)

VAD_STATS = VadStats(
    vad_enabled=True,
    speech_active_ratio=0.5,
    segment_count=2,
    mean_segment_duration_sec=0.25,
    speech_to_pause_ratio=1.0,
    snr_db=12.5,
)


class FakePipeline:
    """Records the commands a publish buffers, and fails execution on demand"""

    def __init__(
        self, commands: list[tuple[Any, ...]], error: Exception | None
    ):
        self.commands = commands
        self._error = error

    def set(self, key: str, value: str, px: int | None = None):
        """Records a SET"""
        self.commands.append(("set", key, value, px))
        return self

    def zadd(self, key: str, mapping: dict[str, float]):
        """Records a ZADD"""
        self.commands.append(("zadd", key, mapping))
        return self

    def zremrangebyscore(self, key: str, min_score: float, max_score: float):
        """Records a ZREMRANGEBYSCORE"""
        self.commands.append(("zremrangebyscore", key, min_score, max_score))
        return self

    async def execute(self):
        """Executes the buffered commands, raising if this write is meant to fail"""
        if self._error is not None:
            raise self._error
        return [True] * len(self.commands)


class FakeRedis:
    """Minimal stand-in for the telemetry Redis client"""

    def __init__(self):
        self.commands: list[tuple[Any, ...]] = []
        self.transaction_flags: list[bool] = []
        self.error: Exception | None = None

    def pipeline(self, transaction: bool = True):
        """Opens a pipeline, recording whether it was asked to be transactional"""
        self.transaction_flags.append(transaction)
        return FakePipeline(self.commands, self.error)


def _publisher(redis_client: FakeRedis, min_publish_interval_sec: float = 2.0):
    logger = MagicMock(spec=ContextLogger)
    return (
        RedisSessionAudioPublisher(
            redis_client, logger, "ts-host-1", min_publish_interval_sec
        ),
        logger,
    )


async def _drain():
    """Lets any tasks scheduled by publish() run to completion."""
    await asyncio.sleep(0)
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_publish_with_none_session_uid_is_a_no_op():
    """A result with no session_uid has nothing to key by in Redis."""
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client)

    # Act
    publisher.publish(None, ROOM_UID, STATS)
    await _drain()

    # Assert
    assert not redis_client.commands


@pytest.mark.asyncio
@freeze_time(NOW)
async def test_publishes_the_stats_under_this_sessions_key():
    """A publish writes the session's snapshot, camelCase and all."""
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client)

    # Act
    publisher.publish(SESSION_UID, ROOM_UID, STATS)
    await _drain()

    # Assert
    command, key, value, px = redis_client.commands[0]
    assert (command, key) == ("set", SNAPSHOT_KEY)
    assert json.loads(value) == {
        "rmsDbfs": STATS.rms_dbfs,
        "peakDbfs": STATS.peak_dbfs,
        "clippingPct": STATS.clipping_pct,
        "silence": STATS.silence,
        "noiseFloorDbfs": STATS.noise_floor_dbfs,
        "vadStats": None,
        "sessionUid": SESSION_UID,
        "roomUid": ROOM_UID,
        "transcriptionHost": "ts-host-1",
        "updatedAt": NOW_MS,
    }
    assert px == AUDIO_STATS_TTL_MS


@pytest.mark.asyncio
@freeze_time(NOW)
async def test_publishes_vad_stats_alongside_audio_stats_when_present():
    """A publish given vad_stats folds it into the same record, camelCase."""
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client)

    # Act
    publisher.publish(SESSION_UID, ROOM_UID, STATS, VAD_STATS)
    await _drain()

    # Assert
    _, _, value, _ = redis_client.commands[0]
    record = json.loads(value)
    assert record["vadStats"] == {
        "vadEnabled": VAD_STATS.vad_enabled,
        "speechActiveRatio": VAD_STATS.speech_active_ratio,
        "segmentCount": VAD_STATS.segment_count,
        "meanSegmentDurationSec": VAD_STATS.mean_segment_duration_sec,
        "speechToPauseRatio": VAD_STATS.speech_to_pause_ratio,
        "snrDb": VAD_STATS.snr_db,
    }


@pytest.mark.asyncio
@freeze_time(NOW)
async def test_publishes_with_vad_stats_none_writes_a_null_field():
    """
    A publish with vad_stats=None (VAD off, or no VAD ran this batch) still
    writes the record - just with a null vadStats, not a skipped publish.
    """
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client)

    # Act
    publisher.publish(SESSION_UID, ROOM_UID, STATS, None)
    await _drain()

    # Assert
    _, _, value, _ = redis_client.commands[0]
    record = json.loads(value)
    assert record["vadStats"] is None
    assert record["rmsDbfs"] == STATS.rms_dbfs  # audio_stats still published


@pytest.mark.asyncio
@freeze_time(NOW)
async def test_indexes_the_session_at_the_records_own_timestamp():
    """Test the index score is the record's updatedAt, in the same unit."""
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client)

    # Act
    publisher.publish(SESSION_UID, ROOM_UID, STATS)
    await _drain()

    # Assert
    assert redis_client.commands[1] == (
        "zadd",
        TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
        {SESSION_UID: NOW_MS},
    )


@pytest.mark.asyncio
@freeze_time(NOW)
async def test_prunes_the_index_of_everything_older_than_the_ttl():
    """Every write drops expired members from the index."""
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client)

    # Act
    publisher.publish(SESSION_UID, ROOM_UID, STATS)
    await _drain()

    # Assert
    assert redis_client.commands[2] == (
        "zremrangebyscore",
        TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
        0,
        NOW_MS - AUDIO_STATS_TTL_MS,
    )


@pytest.mark.asyncio
async def test_writes_without_a_transaction():
    """The write is a pipeline, not a MULTI."""
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client)

    # Act
    publisher.publish(SESSION_UID, ROOM_UID, STATS)
    await _drain()

    # Assert
    assert redis_client.transaction_flags == [False]


@pytest.mark.asyncio
async def test_second_publish_within_the_throttle_interval_is_dropped():
    """Two publishes for the same session within the interval write once."""
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client, min_publish_interval_sec=100.0)

    # Act
    publisher.publish(SESSION_UID, ROOM_UID, STATS)
    publisher.publish(SESSION_UID, ROOM_UID, STATS)
    await _drain()

    # Assert
    assert len(redis_client.commands) == 3  # one write's worth: set/zadd/zrem


@pytest.mark.asyncio
async def test_publishes_more_than_the_interval_apart_both_write():
    """Two publishes farther apart than the throttle interval both land."""
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client, min_publish_interval_sec=0.01)

    # Act
    with freeze_time(NOW) as frozen:
        publisher.publish(SESSION_UID, ROOM_UID, STATS)
        await _drain()
        frozen.tick(delta=0.02)
        publisher.publish(SESSION_UID, ROOM_UID, STATS)
        await _drain()

    # Assert - two writes, each a set/zadd/zrem triple.
    assert len(redis_client.commands) == 6


@pytest.mark.asyncio
async def test_different_sessions_are_throttled_independently():
    """One session publishing does not consume another's throttle window."""
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client, min_publish_interval_sec=100.0)

    # Act
    publisher.publish(SESSION_UID, ROOM_UID, STATS)
    publisher.publish("session-2", None, STATS)
    await _drain()

    # Assert
    assert len(redis_client.commands) == 6


@pytest.mark.asyncio
async def test_forget_clears_throttle_state_so_the_next_publish_is_immediate():
    """forget() lets a subsequent publish() write regardless of prior timing."""
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client, min_publish_interval_sec=100.0)

    # Act
    publisher.publish(SESSION_UID, ROOM_UID, STATS)
    await _drain()
    publisher.forget(SESSION_UID)
    publisher.publish(SESSION_UID, ROOM_UID, STATS)
    await _drain()

    # Assert - two writes despite the long throttle interval.
    assert len(redis_client.commands) == 6


@pytest.mark.asyncio
async def test_forget_with_none_session_uid_is_a_no_op():
    """forget(None) does not raise, and touches nothing."""
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client)

    # Act / Assert
    publisher.forget(None)


@pytest.mark.asyncio
async def test_a_failed_write_never_escapes_and_is_logged():
    """A Redis error during the write is caught and logged, never raised."""
    # Arrange
    redis_client = FakeRedis()
    redis_client.error = ConnectionError("connection refused")
    publisher, logger = _publisher(redis_client)

    # Act
    publisher.publish(SESSION_UID, ROOM_UID, STATS)
    await _drain()

    # Assert
    logger.warning.assert_called_once()
