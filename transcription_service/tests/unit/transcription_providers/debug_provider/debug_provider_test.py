"""
Unit tests for DebugProvider
"""

import asyncio
import logging
import re
from os import path
from unittest.mock import MagicMock

import pytest
import pytest_asyncio

from src.shared.logger import ContextLogger, Logger
from src.shared.utils.worker_pool import WorkerPool
from src.transcription_provider_interface import (
    STAGE_ASR_INPUT,
    STAGE_INGRESS,
    TranscriptionClientError,
    TranscriptionResult,
    TranscriptionSessionInterface,
)
from src.transcription_providers.debug_provider import (
    DebugProvider,
    DebugSessionConfig,
)
from src.transcription_providers.debug_provider.debug_provider import (
    DEBUG_JOB_PERIOD_MS,
)
from src.transcription_providers.debug_provider.debug_provider_job import (
    DebugProviderJob,
)

AUDIO_DIR = path.normpath(
    path.join(
        __file__,
        "..",
        "..",
        "..",
        "..",
        "..",
        "..",
        "test_audio_files/musical_chords",
    )
)

SESSION_CONFIG = DebugSessionConfig(sample_rate=48_000, num_channels=1)


@pytest_asyncio.fixture
async def debug_provider_worker_pool():
    """
    Creates the WorkerPool underlying debug_provider_session, exposed
    separately so tests can inspect its snapshots
    """
    logger = MagicMock(spec=logging.Logger)
    logger.level = 10

    worker_pool = WorkerPool(ContextLogger(logger), 1, [])
    yield worker_pool
    worker_pool.shutdown()


@pytest_asyncio.fixture
async def debug_provider_session(debug_provider_worker_pool: WorkerPool):
    """
    Creates a new transcription session for each test and cleans up after test
    """
    provider = DebugProvider(
        None, MagicMock(spec=Logger), debug_provider_worker_pool, "debug"
    )
    session = provider.create_session(
        SESSION_CONFIG, "session-1", "room-1", MagicMock(spec=Logger)
    )

    yield session

    session.end_session()
    provider.cleanup_provider()


def test_debug_provider_stores_session_and_room_uid(
    debug_provider_session: TranscriptionSessionInterface,
):
    """
    Test that create_session's session_uid/room_uid land on the session
    """
    # Assert
    assert debug_provider_session.session_uid == "session-1"
    assert debug_provider_session.room_uid == "room-1"


def test_debug_provider_registers_job_correlated_to_session_and_room_uid(
    # pylint: disable=unused-argument
    debug_provider_session: TranscriptionSessionInterface,
    debug_provider_worker_pool: WorkerPool,
):
    """
    Test the session's job is correlated to session_uid/room_uid in the pool's
    worker snapshots - what makes /providers/health show it as an ActiveJob
    """
    # Act
    (snapshot,) = debug_provider_worker_pool.worker_snapshots()

    # Assert
    assert len(snapshot.active_jobs) == 1
    assert snapshot.active_jobs[0].session_uid == "session-1"
    assert snapshot.active_jobs[0].room_uid == "room-1"


@pytest.mark.timeout(2)
@pytest.mark.asyncio
async def test_debug_provider_returns_audio_debug_info(
    debug_provider_session: TranscriptionSessionInterface,
):
    """
    Test that debug transcription provider emits transcription containing debug info
    """
    # Arrange
    with open(path.join(AUDIO_DIR, "mono_f64le.wav"), "rb") as f:
        chunk = f.read()

    results: list[TranscriptionResult] = []
    debug_provider_session.on(
        debug_provider_session.TranscriptionResultEvent, results.append
    )

    # Act
    debug_provider_session.start_session()
    debug_provider_session.handle_audio_chunk("chunk-1", chunk)
    await asyncio.sleep(1.2)

    # Assert
    assert len(results) == 2
    assert results[0].in_progress is None
    assert results[0].final is not None
    assert results[0].final.text == [
        f"Session sample rate: {SESSION_CONFIG.sample_rate}. ",
        f"Session channel count: {SESSION_CONFIG.num_channels}. ",
    ]

    assert results[1].in_progress is not None
    assert results[1].final is None
    assert (
        results[1].in_progress.text[0] == "Processed 4.0000 seconds of audio. "
    )
    decode_time = re.match(
        r"^Decode job took (\d+) nanoseconds. $", results[1].in_progress.text[1]
    )
    assert decode_time is not None


@pytest.mark.timeout(2)
@pytest.mark.asyncio
async def test_debug_provider_reports_the_asr_input_stage(
    debug_provider_session: TranscriptionSessionInterface,
):
    """
    Test that the stage reading the job takes survives the trip out of the
    worker process and onto the emitted result.

    The provider that reports no stage publishes no audio snapshot at all,
    which the dashboard reads as "no audio reaching the ASR" - and this is the
    only provider whose telemetry can be exercised without an ASR model, so it
    is also what makes the live-stack cross-check cheap. Going through the real
    worker pool is the point: the reading is pickled across a process boundary.
    """
    # Arrange
    with open(path.join(AUDIO_DIR, "mono_f64le.wav"), "rb") as f:
        chunk = f.read()

    results: list[TranscriptionResult] = []
    debug_provider_session.on(
        debug_provider_session.TranscriptionResultEvent, results.append
    )

    # Act
    debug_provider_session.handle_audio_chunk("chunk-1", chunk)
    await asyncio.sleep(1.2)

    # Assert
    (asr_input,) = results[0].audio_stages
    assert asr_input.stage == STAGE_ASR_INPUT
    assert asr_input.inputs == (STAGE_INGRESS,)
    assert asr_input.audio_seconds == pytest.approx(4.0)
    # Throughput only: this provider meters nothing and detects nothing, and a
    # zero-valued reading for either would claim a measurement it never took.
    assert asr_input.levels is None
    assert asr_input.vad is None


def test_debug_job_seconds_accumulate_across_batches():
    """
    Test that the stage total is cumulative for the life of the session while
    the transcript keeps reporting the per-batch figure.

    The total is compared against the ingress total by subtraction, so a
    per-batch value there would read as the pipeline losing almost everything
    it received; the transcript, in contrast, is a per-execution debug line and
    an integration test asserts on its exact wording.
    """
    # Arrange
    job = DebugProviderJob(SESSION_CONFIG)
    log = MagicMock(spec=Logger)
    with open(path.join(AUDIO_DIR, "mono_f64le.wav"), "rb") as f:
        chunk = f.read()

    # Act
    first = job.process_batch(log, (), [chunk])
    second = job.process_batch(log, (), [chunk])

    # Assert
    assert first.seconds_decoded == pytest.approx(4.0)
    assert second.seconds_decoded == pytest.approx(4.0)
    assert first.audio_stages[0].audio_seconds == pytest.approx(4.0)
    assert second.audio_stages[0].audio_seconds == pytest.approx(8.0)


def test_debug_job_reports_the_stage_when_a_batch_brought_no_audio():
    """
    Test that a period with nothing queued still reports the running total.

    A job period with an empty batch is normal (the pool fires on a timer), and
    dropping the stage then would make the funnel flicker between "reporting"
    and "reported nothing" on a session that is merely between chunks.
    """
    # Arrange
    job = DebugProviderJob(SESSION_CONFIG)
    log = MagicMock(spec=Logger)

    # Act
    result = job.process_batch(log, (), [])

    # Assert
    assert result.seconds_decoded == 0.0
    (asr_input,) = result.audio_stages
    assert asr_input.audio_seconds == 0.0


@pytest.mark.timeout(2)
@pytest.mark.asyncio
async def test_debug_provider_throws_exception_on_bad_chunk(
    debug_provider_session: TranscriptionSessionInterface,
):
    """
    Test that debug transcription provider emits error event on bad audio chunk
    """
    # Arrange
    with open(path.join(AUDIO_DIR, "quad_f64le.wav"), "rb") as f:
        chunk = f.read()

    results: list[Exception] = []
    debug_provider_session.on(
        debug_provider_session.TranscriptionErrorEvent, results.append
    )

    # Act
    debug_provider_session.start_session()
    debug_provider_session.handle_audio_chunk("chunk-1", chunk)
    await asyncio.sleep(1.2)

    # Assert
    assert len(results) == 1
    assert isinstance(results[0], TranscriptionClientError)


def test_debug_provider_reports_the_period_it_schedules():
    """
    Test the reported job period is the one register_job receives

    This provider has no config to read a period from - it is a literal - so
    the reported value and the scheduled one could easily drift apart. They
    come from one constant precisely so they cannot.
    """
    # Arrange
    mock_worker_pool = MagicMock(spec=WorkerPool)
    provider = DebugProvider(
        None, MagicMock(spec=Logger), mock_worker_pool, "debug"
    )

    # Act
    provider.create_session(SESSION_CONFIG, None, None, MagicMock(spec=Logger))

    # Assert
    args, _ = mock_worker_pool.register_job.call_args
    assert provider.job_period_ms == DEBUG_JOB_PERIOD_MS
    assert args[1] == provider.job_period_ms
