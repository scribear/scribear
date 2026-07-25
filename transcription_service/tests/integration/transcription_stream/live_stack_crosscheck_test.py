"""
PLAN-AUDIOVIZ §9 cross-check gate, live-stack leg

The three offline legs pin both meter implementations and the webapp's render
path to `tools/audio-meter-crosscheck/fixtures.json`. All three can pass while
the dashboard shows nothing, because none of them carries audio over the wire:
a regression in the frame protocol, the decoder, the ingress meter's wiring, the
stage graph, or the publisher is invisible to every one of them.

This suite closes that gap for everything between a source device's bytes and
the Redis key `/fleet` reads. It streams the manifest's own WAV excerpt into a
**real** webserver over a **real** websocket as SAFP frames, and asserts the
snapshot that lands in a **real** Redis reports the manifest's dBFS.

What that covers, which nothing did before: `encode_audio_frame`/
`decode_audio_frame`, the per-chunk decode, `SessionAudioTracker`'s ingress
meter, stage-graph depth resolution, and `RedisSessionAudioPublisher`'s payload.

Deliberately runs on the **debug** provider, which loads no model. Before the
stage graph that was impossible - metering lived inside the whisper job, so a
live-stack test needed a real Whisper - and it is the main reason this leg is
cheap enough to exist at all (§12.1).

What it still does not cover, and the README says so too: node-server (the hop
from a source device to this service), `FleetTelemetryService`'s read, and any
browser. The seam this leg stops at is the Redis payload; the admin-server
integration suite picks it up from there.
"""

import asyncio
import io
import json
import logging
import os
import wave
from pathlib import Path
from unittest.mock import MagicMock

import numpy as np
import pytest
import pytest_asyncio
import soundfile as sf
from fastapi.testclient import TestClient
from redis.asyncio import Redis

from src.shared.config import (
    Config,
    TranscriptionProviderConfigSchema,
    TranscriptionProviderUID,
)
from src.shared.logger import ContextLogger, Logger
from src.shared.utils.audio_frame_protocol import encode_audio_frame
from src.transcription_provider_interface import STAGE_ASR_INPUT, STAGE_INGRESS
from src.webserver.create_webserver import create_webserver
from src.webserver.features.telemetry.telemetry_keys import (
    transcription_session_audio_key,
)

REDIS_URL = os.environ.get("REDIS_URL", "")
API_KEY = "TEST_KEY"
SESSION_UID = "live-stack-crosscheck-session"
ROOM_UID = "live-stack-crosscheck-room"

# The publisher's own throttle. Waited out once mid-stream so that a publish
# lands while the meter's window is full rather than only on the first chunk.
PUBLISH_THROTTLE_SEC = 2.0

# Chunk size the kiosk actually sends (AUDIO_CHUNK_MS), and what the sidecar's
# canary mirrors. Metering at ingress happens per chunk, so streaming at the
# real chunk size is part of what this leg is checking.
CHUNK_MS = 100

pytestmark = [
    pytest.mark.timeout(60),
    pytest.mark.skipif(
        not REDIS_URL, reason="REDIS_URL is unset; no backplane to publish to"
    ),
]


def _repo_root() -> Path:
    """
    Walks up to the directory holding both the fixture manifest and the WAV.

    Same reasoning as the offline leg: the working directory depends on where
    pytest was invoked from, so neither it nor a fixed number of hops is
    assumed.
    """
    for candidate in [
        Path(__file__).resolve(),
        *Path(__file__).resolve().parents,
    ]:
        if (candidate / "tools/audio-meter-crosscheck/fixtures.json").is_file():
            return candidate
    raise AssertionError(
        "Could not locate tools/audio-meter-crosscheck/fixtures.json above "
        f"{__file__}"
    )


REPO_ROOT = _repo_root()
FIXTURES = json.loads(
    (REPO_ROOT / "tools/audio-meter-crosscheck/fixtures.json").read_text(
        encoding="utf-8"
    )
)
TOLERANCE_DB = FIXTURES["toleranceDb"]
WAV_FIXTURE = FIXTURES["wav"]


def _excerpt() -> np.ndarray:
    """
    The manifest's excerpt: the first `sampleCount` samples, as float32.

    Read with `wave` and converted by hand rather than via soundfile, so this
    reads the file the same way the offline leg does and the two legs cannot
    disagree about the samples they are describing.
    """
    path = REPO_ROOT / WAV_FIXTURE["path"]
    with wave.open(str(path), "rb") as handle:
        assert handle.getframerate() == WAV_FIXTURE["sampleRate"]
        assert handle.getnchannels() == 1
        assert handle.getsampwidth() == 2
        raw = handle.readframes(WAV_FIXTURE["sampleCount"])

    samples = np.frombuffer(raw, dtype="<i2")
    assert samples.size == WAV_FIXTURE["sampleCount"], (
        f"WAV holds {samples.size} samples, manifest expects "
        f"{WAV_FIXTURE['sampleCount']}"
    )
    return (samples.astype(np.float32) / 32768.0).astype(np.float32)


def _wav_chunks(samples: np.ndarray) -> list[bytes]:
    """
    Slices `samples` into self-contained WAV chunks of CHUNK_MS each.

    Each chunk is its own WAV container because that is what the decoder
    expects: `AudioDecoder.decode` opens every chunk with soundfile and
    validates its header, so a bare PCM slice would be rejected. This mirrors
    what a source device sends.
    """
    rate = WAV_FIXTURE["sampleRate"]
    per_chunk = rate * CHUNK_MS // 1000
    chunks: list[bytes] = []
    for start in range(0, samples.size, per_chunk):
        block = samples[start : start + per_chunk]
        if block.size == 0:
            continue
        buffer = io.BytesIO()
        sf.write(buffer, block, rate, format="WAV", subtype="PCM_16")
        chunks.append(buffer.getvalue())
    return chunks


@pytest.fixture(name="mock_logger")
def mock_logger_fixture():
    """Logger that records nothing, so a failure's output is the assertion."""
    underlying = MagicMock(spec=logging.Logger)
    underlying.level = 10
    return ContextLogger(underlying)


@pytest.fixture(name="mock_config")
def mock_config_fixture():
    """
    Config for a debug-provider host publishing to the real Redis.

    `debug` and not whisper on purpose: it loads no model, and since the ingress
    meter lives above the provider it produces the very same levels a whisper
    host would report at that stage.
    """
    mock = MagicMock(spec=Config)
    mock.api_key = API_KEY
    mock.redis_url = REDIS_URL
    mock.transcription_host_id = "live-stack-crosscheck-host"
    mock.ws_init_timeout_sec = 5.0
    mock.audio_silence_threshold = 0.01
    mock.provider_config.num_workers = 1
    mock.provider_config.contexts = []
    mock.provider_config.providers = {
        "debug": TranscriptionProviderConfigSchema(
            provider_uid=TranscriptionProviderUID.DEBUG, provider_config=None
        )
    }
    return mock


@pytest_asyncio.fixture(name="redis_client")
async def redis_client_fixture():
    """Second connection, used only to read back what the service published."""
    client = Redis.from_url(REDIS_URL, decode_responses=True)
    await client.delete(transcription_session_audio_key(SESSION_UID))
    yield client
    await client.delete(transcription_session_audio_key(SESSION_UID))
    await client.aclose()


@pytest_asyncio.fixture(name="test_client")
async def test_client_fixture(mock_config: Config, mock_logger: Logger):
    """Real webserver, real worker subprocess, real publisher."""
    with TestClient(create_webserver(mock_config, mock_logger)) as client:
        yield client


def _stage(payload: dict, stage_id: str) -> dict:
    """Pulls one stage out of a published snapshot by id."""
    for stage in payload["stages"]:
        if stage["stage"] == stage_id:
            return stage
    raise AssertionError(
        f"no {stage_id!r} stage in published snapshot; got "
        f"{[s['stage'] for s in payload['stages']]}"
    )


async def _published_snapshot(redis_client: Redis) -> dict:
    """
    Reads the session's snapshot, waiting for the publisher's detached task.

    `publish()` is fire-and-forget - it schedules the write on the event loop
    and returns - so the key can lag the last frame by a moment. Polls rather
    than sleeping a fixed guess.
    """
    key = transcription_session_audio_key(SESSION_UID)
    for _ in range(50):
        raw = await redis_client.get(key)
        if raw is not None:
            return json.loads(raw)
        await asyncio.sleep(0.1)
    raise AssertionError(f"nothing published to {key} within 5s")


@pytest.mark.asyncio
async def test_streamed_excerpt_reports_the_manifest_dbfs_through_the_live_stack(
    test_client: TestClient, redis_client: Redis
):
    """
    The manifest's excerpt, streamed over the real wire, reads as the manifest
    says at the ingress stage.

    This is the assertion PLAN-AUDIOVIZ §9 asks for and the offline legs cannot
    make: every layer between a source device's bytes and the published snapshot
    participates, so a regression in framing, decoding, metering, the stage
    graph or the publisher fails here even though all three offline legs still
    pass.

    The excerpt is streamed **twice**. One pass fills the 10 s window exactly;
    the throttle wait then guarantees the publish that follows is not the
    first-chunk one, and the second pass supplies a frame to trigger it. Because
    the meter's window is exactly the excerpt's length, any window over a looped
    excerpt is a rotation of it - the same samples in a different order - so RMS
    and peak are unchanged and the manifest's arithmetic still applies. (Noise
    floor is not asserted for exactly this reason: it is a percentile over 1 s
    sub-windows, whose boundaries a rotation does move.)
    """
    # Arrange
    chunks = _wav_chunks(_excerpt())
    assert len(chunks) == 100, f"expected 100 x {CHUNK_MS}ms chunks"

    # Act
    with test_client.websocket_connect(
        "/transcription_stream/debug"
    ) as websocket:
        websocket.send_json({"type": "auth", "api_key": API_KEY})
        websocket.send_json(
            {
                "type": "config",
                "config": {"sample_rate": 16000, "num_channels": 1},
                "session_uid": SESSION_UID,
                "room_uid": ROOM_UID,
            }
        )

        for index, chunk in enumerate(chunks):
            websocket.send_bytes(encode_audio_frame(f"chunk-{index}", chunk))
        await asyncio.sleep(PUBLISH_THROTTLE_SEC + 0.2)
        for index, chunk in enumerate(chunks):
            websocket.send_bytes(
                encode_audio_frame(f"chunk-loop-{index}", chunk)
            )

        payload = await _published_snapshot(redis_client)

    # Assert - the levels the manifest defines arithmetically.
    ingress = _stage(payload, STAGE_INGRESS)
    levels = ingress["levels"]
    assert levels is not None, "ingress must report levels for every provider"
    assert (
        abs(levels["rmsDbfs"] - WAV_FIXTURE["expected"]["rmsDbfs"])
        < TOLERANCE_DB
    ), (
        f"ingress RMS {levels['rmsDbfs']:.4f} dBFS is more than "
        f"{TOLERANCE_DB} dB from the manifest's "
        f"{WAV_FIXTURE['expected']['rmsDbfs']}"
    )
    assert (
        abs(levels["peakDbfs"] - WAV_FIXTURE["expected"]["peakDbfs"])
        < TOLERANCE_DB
    ), (
        f"ingress peak {levels['peakDbfs']:.4f} dBFS is more than "
        f"{TOLERANCE_DB} dB from the manifest's "
        f"{WAV_FIXTURE['expected']['peakDbfs']}"
    )
    # Speech at -26 dBFS is nowhere near the rail, so anything above zero here
    # means the clipping rule has regressed into firing on undistorted audio -
    # the defect 063e7a6 fixed.
    assert levels["clippingPct"] == WAV_FIXTURE["expected"]["clippingPct"]
    assert levels["silence"] is False


@pytest.mark.asyncio
async def test_the_published_graph_is_shaped_as_the_contract_says(
    test_client: TestClient, redis_client: Redis
):
    """
    The stage graph arrives with its edges and derived depths intact.

    Separate from the levels assertion above because it fails for a different
    reason: the numbers can be right while the topology a reader needs to draw
    the pipeline - and to attribute loss to an edge - is wrong. Depth is derived
    at publish time (§12.2), so it is only ever checked on a real publish.
    """
    # Arrange
    chunks = _wav_chunks(_excerpt())

    # Act
    with test_client.websocket_connect(
        "/transcription_stream/debug"
    ) as websocket:
        websocket.send_json({"type": "auth", "api_key": API_KEY})
        websocket.send_json(
            {
                "type": "config",
                "config": {"sample_rate": 16000, "num_channels": 1},
                "session_uid": SESSION_UID,
                "room_uid": ROOM_UID,
            }
        )
        for index, chunk in enumerate(chunks[:20]):
            websocket.send_bytes(encode_audio_frame(f"chunk-{index}", chunk))
        payload = await _published_snapshot(redis_client)

    # Assert - envelope identifies the session and the publishing host.
    assert payload["sessionUid"] == SESSION_UID
    assert payload["roomUid"] == ROOM_UID
    assert payload["transcriptionHost"] == "live-stack-crosscheck-host"

    # Assert - ingress is the source of the graph, at depth 1.
    ingress = _stage(payload, STAGE_INGRESS)
    assert ingress["inputs"] == []
    assert ingress["depth"] == 1

    # Assert - this snapshot is the *first* publish, and it carries exactly one
    # chunk's worth of audio even though twenty were sent.
    #
    # That is the push-based contract working, not a lost-audio bug: the very
    # first chunk finds the throttle with nothing to suppress and publishes
    # straight away, and the next nineteen arrive inside
    # min_publish_interval_sec and are dropped. Pinning the figure here is what
    # proves publishing is triggered by arriving audio rather than waiting for a
    # transcription result - the change that made telemetry exist for providers
    # that emit no stats of their own (§12.1). The payload is assembled
    # synchronously before the write is scheduled, so which chunk it reflects is
    # deterministic rather than a race.
    assert ingress["audioSeconds"] == pytest.approx(
        CHUNK_MS / 1000, abs=1e-6
    ), (
        "first publish should carry one chunk; a larger figure means the "
        "throttle let a later chunk through, a smaller one means ingress is "
        "not counting every chunk"
    )


def _alternating_amplitude_signal() -> tuple[np.ndarray, float]:
    """
    A 10 s tone whose amplitude alternates every half-chunk, and its exact RMS.

    Built for one purpose: to fail if the ingress meter is fed anything other
    than every sample. The manifest's speech excerpt cannot do that. Speech is
    near enough stationary across 100 ms that metering only half of each chunk
    moves its RMS and peak by well under the 0.5 dB tolerance - verified by
    mutation, where halving every chunk passed all the assertions above. So the
    excerpt pins the *values* and this pins *completeness*.

    Each 100 ms chunk is 50 ms of a loud sine then 50 ms of a quiet one, 20 dB
    apart. Drop either half and the RMS moves by ~3 dB, six times the tolerance.

    Returns:
        The samples, and the arithmetic RMS in dBFS - derived from the
        amplitudes below, not read off any meter.
    """
    rate = WAV_FIXTURE["sampleRate"]
    loud, quiet = 0.5, 0.05
    half = rate * CHUNK_MS // 2000  # half a chunk, in samples
    cycle = np.concatenate(
        [
            loud * np.sin(2 * np.pi * 1000 * np.arange(half) / rate),
            quiet * np.sin(2 * np.pi * 1000 * np.arange(half) / rate),
        ]
    )
    samples = np.tile(cycle, WAV_FIXTURE["sampleCount"] // cycle.size)

    # Mean square of a full-cycle sine is A^2/2, and the two halves are equally
    # long, so the combined mean square is the average of the two.
    mean_square = (loud**2 / 2 + quiet**2 / 2) / 2
    return samples.astype(np.float32), 20 * np.log10(np.sqrt(mean_square))


@pytest.mark.asyncio
async def test_every_sample_reaches_the_ingress_meter(
    test_client: TestClient, redis_client: Redis
):
    """
    The meter reports the RMS of *all* the audio, not of a subset of it.

    Guards the gap the excerpt leaves open. A regression that fed the meter part
    of each chunk - a slice off by a factor, a decode that returns early, a
    buffer appended before it is filled - keeps roughly the right RMS on speech
    and would pass every other assertion here. Against a signal whose amplitude
    alternates within the chunk it cannot: dropping half of each chunk moves the
    RMS about 3 dB, six times the tolerance.

    The expectation is arithmetic (mean square of a sine is A^2/2, averaged over
    two equal halves), so a failure means the meter is wrong rather than that it
    disagrees with another implementation's opinion.
    """
    # Arrange
    samples, expected_rms_dbfs = _alternating_amplitude_signal()
    assert samples.size == WAV_FIXTURE["sampleCount"]
    chunks = _wav_chunks(samples)

    # Act
    with test_client.websocket_connect(
        "/transcription_stream/debug"
    ) as websocket:
        websocket.send_json({"type": "auth", "api_key": API_KEY})
        websocket.send_json(
            {
                "type": "config",
                "config": {"sample_rate": 16000, "num_channels": 1},
                "session_uid": SESSION_UID,
                "room_uid": ROOM_UID,
            }
        )
        for index, chunk in enumerate(chunks):
            websocket.send_bytes(encode_audio_frame(f"chunk-{index}", chunk))
        await asyncio.sleep(PUBLISH_THROTTLE_SEC + 0.2)
        for index, chunk in enumerate(chunks):
            websocket.send_bytes(
                encode_audio_frame(f"chunk-loop-{index}", chunk)
            )
        payload = await _published_snapshot(redis_client)

    # Assert
    levels = _stage(payload, STAGE_INGRESS)["levels"]
    assert levels is not None
    assert abs(levels["rmsDbfs"] - expected_rms_dbfs) < TOLERANCE_DB, (
        f"ingress RMS {levels['rmsDbfs']:.4f} dBFS vs the arithmetic "
        f"{expected_rms_dbfs:.4f}; a gap near 3 dB means the meter is seeing "
        "only part of each chunk"
    )


@pytest.mark.asyncio
async def test_the_funnel_never_reports_more_audio_downstream_than_upstream(
    test_client: TestClient, redis_client: Redis
):
    """
    Cumulative seconds do not increase down the graph.

    This is the invariant the whole "where did the audio go" reading rests on:
    if a downstream stage can ever claim more audio than the stage feeding it,
    every loss figure derived from the pair is meaningless, and the dashboard
    would render negative loss. Checked on a real publish because the two
    counters are incremented in different processes - ingress in the webserver,
    asr_input inside the worker - and only the published snapshot puts the two
    numbers side by side.
    """
    # Arrange
    chunks = _wav_chunks(_excerpt())

    # Act
    with test_client.websocket_connect(
        "/transcription_stream/debug"
    ) as websocket:
        websocket.send_json({"type": "auth", "api_key": API_KEY})
        websocket.send_json(
            {
                "type": "config",
                "config": {"sample_rate": 16000, "num_channels": 1},
                "session_uid": SESSION_UID,
                "room_uid": ROOM_UID,
            }
        )
        for index, chunk in enumerate(chunks):
            websocket.send_bytes(encode_audio_frame(f"chunk-{index}", chunk))
        # Long enough for the worker to have run a batch and reported its own
        # stage, so there are two counters to compare rather than one.
        await asyncio.sleep(PUBLISH_THROTTLE_SEC + 0.2)
        websocket.send_bytes(encode_audio_frame("chunk-final", chunks[0]))
        payload = await _published_snapshot(redis_client)

    # Assert
    ingress = _stage(payload, STAGE_INGRESS)
    stages = {stage["stage"]: stage for stage in payload["stages"]}
    if STAGE_ASR_INPUT not in stages:
        pytest.skip(
            "worker had not reported asr_input yet; the funnel needs both ends"
        )

    asr_input = stages[STAGE_ASR_INPUT]
    assert asr_input["inputs"] == [STAGE_INGRESS]
    assert asr_input["depth"] == ingress["depth"] + 1
    assert asr_input["audioSeconds"] is not None
    assert ingress["audioSeconds"] is not None
    assert asr_input["audioSeconds"] <= ingress["audioSeconds"] + 1e-9, (
        f"asr_input claims {asr_input['audioSeconds']}s but ingress only saw "
        f"{ingress['audioSeconds']}s"
    )
