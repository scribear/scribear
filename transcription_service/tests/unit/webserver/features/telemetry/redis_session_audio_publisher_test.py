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
from src.transcription_provider_interface import (
    STAGE_ASR_INPUT,
    STAGE_INGRESS,
    STAGE_VAD,
    AudioStageReading,
    VadStats,
)
from src.webserver.features.telemetry import (
    RedisSessionAudioPublisher,
    ResolvedAudioStage,
)
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

INGRESS_STAGE = ResolvedAudioStage(
    reading=AudioStageReading(
        stage=STAGE_INGRESS,
        label="Source ingress",
        inputs=(),
        levels=STATS,
        vad=None,
        audio_seconds=123.4,
    ),
    depth=1,
)

# Throughput only: §12.3's `debug` provider reports seconds without pretending
# to meter, and that has to survive the wire as a null rather than a zero.
ASR_INPUT_STAGE = ResolvedAudioStage(
    reading=AudioStageReading(
        stage=STAGE_ASR_INPUT,
        label="ASR input (worker decode)",
        inputs=(STAGE_INGRESS,),
        levels=None,
        vad=None,
        audio_seconds=122.9,
    ),
    depth=2,
)

VAD_STAGE = ResolvedAudioStage(
    reading=AudioStageReading(
        stage=STAGE_VAD,
        label="VAD (Silero)",
        inputs=(STAGE_ASR_INPUT,),
        levels=None,
        vad=VAD_STATS,
        audio_seconds=47.2,
    ),
    depth=3,
)

STAGES = (INGRESS_STAGE, ASR_INPUT_STAGE, VAD_STAGE)


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
    publisher.publish(None, ROOM_UID, STAGES)
    await _drain()

    # Assert
    assert not redis_client.commands


@pytest.mark.asyncio
@freeze_time(NOW)
async def test_publishes_the_stage_graph_under_this_sessions_key():
    """
    A publish writes the whole graph as one record, in §12.4's shape

    Both sides of this ship from one repo and the key expires in 10 s, so
    there is no compatibility shim behind this: the field names here are the
    contract the TypeScript reader validates against.
    """
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client)

    # Act
    publisher.publish(SESSION_UID, ROOM_UID, STAGES)
    await _drain()

    # Assert
    command, key, value, px = redis_client.commands[0]
    assert (command, key) == ("set", SNAPSHOT_KEY)
    assert json.loads(value) == {
        "stages": [
            {
                "stage": STAGE_INGRESS,
                "label": "Source ingress",
                "depth": 1,
                "inputs": [],
                "levels": {
                    "rmsDbfs": STATS.rms_dbfs,
                    "peakDbfs": STATS.peak_dbfs,
                    "clippingPct": STATS.clipping_pct,
                    "silence": STATS.silence,
                    "noiseFloorDbfs": STATS.noise_floor_dbfs,
                },
                "vad": None,
                "audioSeconds": 123.4,
            },
            {
                "stage": STAGE_ASR_INPUT,
                "label": "ASR input (worker decode)",
                "depth": 2,
                "inputs": [STAGE_INGRESS],
                "levels": None,
                "vad": None,
                "audioSeconds": 122.9,
            },
            {
                "stage": STAGE_VAD,
                "label": "VAD (Silero)",
                "depth": 3,
                "inputs": [STAGE_ASR_INPUT],
                "levels": None,
                "vad": {
                    "vadEnabled": VAD_STATS.vad_enabled,
                    "speechActiveRatio": VAD_STATS.speech_active_ratio,
                    "segmentCount": VAD_STATS.segment_count,
                    "meanSegmentDurationSec": VAD_STATS.mean_segment_duration_sec,
                    "speechToPauseRatio": VAD_STATS.speech_to_pause_ratio,
                    "snrDb": VAD_STATS.snr_db,
                },
                "audioSeconds": 47.2,
            },
        ],
        "sessionUid": SESSION_UID,
        "roomUid": ROOM_UID,
        "transcriptionHost": "ts-host-1",
        "updatedAt": NOW_MS,
    }
    assert px == AUDIO_STATS_TTL_MS


@pytest.mark.asyncio
@freeze_time(NOW)
async def test_publishes_an_ingress_only_graph():
    """
    The `debug`/`lumen_granite` case §12.1 was written for: a provider that
    reports nothing still publishes the webserver's own ingress reading, so
    the dashboard no longer reads a healthy session as "no audio reaching
    ASR".
    """
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client)

    # Act
    publisher.publish(SESSION_UID, ROOM_UID, (INGRESS_STAGE,))
    await _drain()

    # Assert
    _, _, value, _ = redis_client.commands[0]
    record = json.loads(value)
    assert len(record["stages"]) == 1
    assert record["stages"][0]["stage"] == STAGE_INGRESS
    assert record["stages"][0]["levels"]["rmsDbfs"] == STATS.rms_dbfs


@pytest.mark.asyncio
@freeze_time(NOW)
async def test_indexes_the_session_at_the_records_own_timestamp():
    """Test the index score is the record's updatedAt, in the same unit."""
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client)

    # Act
    publisher.publish(SESSION_UID, ROOM_UID, STAGES)
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
    publisher.publish(SESSION_UID, ROOM_UID, STAGES)
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
    publisher.publish(SESSION_UID, ROOM_UID, STAGES)
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
    publisher.publish(SESSION_UID, ROOM_UID, STAGES)
    publisher.publish(SESSION_UID, ROOM_UID, STAGES)
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
        publisher.publish(SESSION_UID, ROOM_UID, STAGES)
        await _drain()
        frozen.tick(delta=0.02)
        publisher.publish(SESSION_UID, ROOM_UID, STAGES)
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
    publisher.publish(SESSION_UID, ROOM_UID, STAGES)
    publisher.publish("session-2", None, STAGES)
    await _drain()

    # Assert
    assert len(redis_client.commands) == 6


@pytest.mark.asyncio
async def test_is_due_agrees_with_what_the_throttle_actually_does():
    """
    The predicate a caller gates an expensive payload on (§12.9: an ingress
    snapshot costs ~218 us, ~7x metering a chunk). If it disagreed with the
    throttle, the caller would either pay the cost for a write that gets
    dropped or skip a write the throttle would have allowed - so it is tested
    against the write, not on its own.
    """
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client, min_publish_interval_sec=100.0)

    # Act / Assert - due before anything has been published.
    assert publisher.is_due(SESSION_UID) is True

    publisher.publish(SESSION_UID, ROOM_UID, STAGES)
    await _drain()

    # Not due inside the window, and a publish anyway writes nothing.
    assert publisher.is_due(SESSION_UID) is False
    publisher.publish(SESSION_UID, ROOM_UID, STAGES)
    await _drain()
    assert len(redis_client.commands) == 3


@pytest.mark.asyncio
async def test_is_due_again_once_the_interval_has_elapsed():
    """
    The window has to reopen on the same clock the throttle uses, or a caller
    gating on this would starve the dashboard while the publisher was ready to
    write.
    """
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client, min_publish_interval_sec=0.01)

    # Act / Assert
    with freeze_time(NOW) as frozen:
        publisher.publish(SESSION_UID, ROOM_UID, STAGES)
        await _drain()
        assert publisher.is_due(SESSION_UID) is False
        frozen.tick(delta=0.02)
        assert publisher.is_due(SESSION_UID) is True


@pytest.mark.asyncio
async def test_is_due_is_false_with_no_session_uid():
    """
    Nothing to key by means nothing to publish, so a caller must not be told
    to assemble a payload that `publish` will discard.
    """
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client)

    # Act / Assert
    assert publisher.is_due(None) is False


@pytest.mark.asyncio
async def test_forget_clears_throttle_state_so_the_next_publish_is_immediate():
    """forget() lets a subsequent publish() write regardless of prior timing."""
    # Arrange
    redis_client = FakeRedis()
    publisher, _ = _publisher(redis_client, min_publish_interval_sec=100.0)

    # Act
    publisher.publish(SESSION_UID, ROOM_UID, STAGES)
    await _drain()
    publisher.forget(SESSION_UID)
    publisher.publish(SESSION_UID, ROOM_UID, STAGES)
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
    publisher.publish(SESSION_UID, ROOM_UID, STAGES)
    await _drain()

    # Assert
    logger.warning.assert_called_once()
