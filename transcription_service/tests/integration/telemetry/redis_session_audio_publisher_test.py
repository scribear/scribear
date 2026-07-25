"""
Integration tests for per-session audio telemetry publishing, against a real
Redis

Skipped unless REDIS_URL names a reachable server, which CI provides as a
service container - same gating and fixture shape as
`redis_telemetry_publisher_test.py`, reused rather than standing up new heavy
infra. What a fake client cannot answer, and this proves instead: the expiry
actually lands on the key, the score reads back through the range query a
reader will issue, and the prune removes what an expired snapshot left in the
index.
"""

import asyncio
import json
import logging
import os
from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from redis.asyncio import Redis

from src.shared.logger import ContextLogger, Logger
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
    create_telemetry_redis_client,
)
from src.webserver.features.telemetry.telemetry_keys import (
    AUDIO_STATS_TTL_MS,
    TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
    transcription_session_audio_key,
)

REDIS_URL = os.environ.get("REDIS_URL", "")
SESSION_UID = "integration-test-session"
ROOM_UID = "integration-test-room"

pytestmark = [
    pytest.mark.timeout(30),
    pytest.mark.skipif(
        not REDIS_URL, reason="REDIS_URL is unset; no backplane to publish to"
    ),
]

STATS = AudioLevelStats(
    rms_dbfs=-18.5,
    peak_dbfs=-6.0,
    clipping_pct=0.0,
    silence=False,
    noise_floor_dbfs=-42.0,
)

VAD_STATS = VadStats(
    vad_enabled=True,
    speech_active_ratio=0.42,
    segment_count=3,
    mean_segment_duration_sec=0.31,
    speech_to_pause_ratio=0.72,
    snr_db=14.2,
)

INGRESS_STAGE = ResolvedAudioStage(
    reading=AudioStageReading(
        stage=STAGE_INGRESS,
        label="Source ingress",
        inputs=(),
        levels=STATS,
        vad=None,
        audio_seconds=33.6,
    ),
    depth=1,
)

# Throughput only, the way §12.3's `debug` provider reports: proving a null
# `levels` survives a real round trip matters because the reader has to tell
# "not measured here" from a zero reading.
ASR_INPUT_STAGE = ResolvedAudioStage(
    reading=AudioStageReading(
        stage=STAGE_ASR_INPUT,
        label="ASR input (worker decode)",
        inputs=(STAGE_INGRESS,),
        levels=None,
        vad=None,
        audio_seconds=33.1,
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
        audio_seconds=12.4,
    ),
    depth=3,
)

STAGES = (INGRESS_STAGE, ASR_INPUT_STAGE, VAD_STAGE)


@pytest.fixture
def mock_logger():
    """
    Create a mocked logger instance for testing
    """
    underlying_logger = MagicMock(spec=logging.Logger)
    underlying_logger.level = 10
    return ContextLogger(underlying_logger)


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
        transcription_session_audio_key(SESSION_UID),
        TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
    )
    yield client
    await client.delete(
        transcription_session_audio_key(SESSION_UID),
        TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
    )
    await client.aclose()


@pytest_asyncio.fixture
async def publisher(mock_logger: Logger):
    """
    Create a publisher over a real connection, with a short throttle window
    so successive test writes are not dropped as duplicates.
    """
    instance = RedisSessionAudioPublisher(
        create_telemetry_redis_client(REDIS_URL),
        mock_logger,
        "ts-host-1",
        min_publish_interval_sec=0.0,
    )
    yield instance
    await instance.aclose()


async def _wait_for_key(reader: Redis, key: str):
    """Polls for a key to appear, since publish() schedules its write as a task."""
    for _ in range(100):
        value = await reader.get(key)
        if value is not None:
            return value
        await asyncio.sleep(0.05)
    return None


@pytest.mark.asyncio
async def test_snapshot_lands_with_an_expiry_on_it(
    publisher: RedisSessionAudioPublisher, reader: Redis
):
    """
    Test the published key carries the contract's TTL and shape

    Liveness is expiry: nothing deletes this key, so a session that stops
    publishing has to disappear on its own. A write that landed without its
    expiry would leave a dead session on the dashboard forever, and only the
    server can say whether the expiry is really there.
    """
    # Act
    publisher.publish(SESSION_UID, ROOM_UID, STAGES)

    # Assert
    key = transcription_session_audio_key(SESSION_UID)
    payload = await _wait_for_key(reader, key)
    assert payload is not None

    ttl_ms = await reader.pttl(key)
    assert 0 < ttl_ms <= AUDIO_STATS_TTL_MS

    record = json.loads(payload)
    assert record["sessionUid"] == SESSION_UID
    assert record["roomUid"] == ROOM_UID
    assert record["transcriptionHost"] == "ts-host-1"

    ingress = record["stages"][0]
    assert ingress["stage"] == STAGE_INGRESS
    assert ingress["depth"] == 1
    assert ingress["levels"] == {
        "rmsDbfs": STATS.rms_dbfs,
        "peakDbfs": STATS.peak_dbfs,
        "clippingPct": STATS.clipping_pct,
        "silence": STATS.silence,
        "noiseFloorDbfs": STATS.noise_floor_dbfs,
    }


@pytest.mark.asyncio
async def test_the_stage_graph_round_trips_through_a_real_redis(
    publisher: RedisSessionAudioPublisher, reader: Redis
):
    """
    Test the whole graph survives a real write/read through Redis

    §12.4 puts every stage in one key/write rather than one key per stage, so
    a reader can never see one end of an edge without the other. This is the
    one integration point that proves the nested objects - and, crucially, the
    edges in `inputs` - really round-trip as JSON rather than only through a
    fake pipeline.
    """
    # Act
    publisher.publish(SESSION_UID, ROOM_UID, STAGES)

    # Assert
    key = transcription_session_audio_key(SESSION_UID)
    payload = await _wait_for_key(reader, key)
    assert payload is not None

    stages = json.loads(payload)["stages"]
    assert [(stage["stage"], stage["depth"]) for stage in stages] == [
        (STAGE_INGRESS, 1),
        (STAGE_ASR_INPUT, 2),
        (STAGE_VAD, 3),
    ]
    assert [stage["inputs"] for stage in stages] == [
        [],
        [STAGE_INGRESS],
        [STAGE_ASR_INPUT],
    ]
    # Throughput-only stages carry a null readout, not a zeroed one.
    assert stages[1]["levels"] is None
    assert stages[1]["vad"] is None
    assert stages[1]["audioSeconds"] == ASR_INPUT_STAGE.reading.audio_seconds
    assert stages[2]["vad"] == {
        "vadEnabled": VAD_STATS.vad_enabled,
        "speechActiveRatio": VAD_STATS.speech_active_ratio,
        "segmentCount": VAD_STATS.segment_count,
        "meanSegmentDurationSec": VAD_STATS.mean_segment_duration_sec,
        "speechToPauseRatio": VAD_STATS.speech_to_pause_ratio,
        "snrDb": VAD_STATS.snr_db,
    }


@pytest.mark.asyncio
async def test_session_is_found_by_the_range_query_the_reader_will_issue(
    publisher: RedisSessionAudioPublisher, reader: Redis
):
    """
    Test the index score reads back inside the reader's staleness window

    A reader must range the index from `now - TTL` rather than trust it
    whole, because sorted-set members have no expiry of their own. This is
    that query, and it is what proves the score is in the same unit as the
    window.
    """
    # Act
    publisher.publish(SESSION_UID, ROOM_UID, STAGES)
    record = json.loads(
        await _wait_for_key(
            reader, transcription_session_audio_key(SESSION_UID)
        )
    )

    # Assert
    live = await reader.zrangebyscore(
        TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
        record["updatedAt"] - AUDIO_STATS_TTL_MS,
        "+inf",
    )
    assert live == [SESSION_UID.encode()]

    score = await reader.zscore(
        TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY, SESSION_UID
    )
    assert score == record["updatedAt"]


@pytest.mark.asyncio
async def test_a_publish_prunes_a_session_whose_snapshot_has_expired(
    publisher: RedisSessionAudioPublisher, reader: Redis
):
    """
    Test the index does not accumulate sessions that stopped publishing

    The member outlives the snapshot it points at, so without a prune the
    index grows with the identity of every session ever served - and pruning
    is by score rather than by session precisely so that whoever publishes
    next clears a session that died without unregistering.
    """
    # Arrange - a session that last published two TTLs ago and never came back.
    await reader.zadd(
        TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY, {"long-dead-session": 1}
    )

    # Act
    publisher.publish(SESSION_UID, ROOM_UID, STAGES)
    await _wait_for_key(reader, transcription_session_audio_key(SESSION_UID))

    # Assert
    members = await reader.zrange(TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY, 0, -1)
    assert members == [SESSION_UID.encode()]
