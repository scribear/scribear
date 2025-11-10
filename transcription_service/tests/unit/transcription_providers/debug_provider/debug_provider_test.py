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
    TranscriptionClientError,
    TranscriptionResult,
    TranscriptionSessionInterface,
)
from src.transcription_providers.debug_provider import (
    DebugProvider,
    DebugSessionConfig,
)

AUDIO_DIR = path.normpath(
    path.join(
        __file__, "..", "..", "..", "..", "..", "..", "test_audio_files/chords"
    )
)

SESSION_CONFIG = DebugSessionConfig(sample_rate=48_000, num_channels=1)


@pytest_asyncio.fixture
async def debug_provider_session():
    """
    Creates a new transcription session for each test and cleans up after test
    """
    logger = MagicMock(spec=logging.Logger)
    logger.level = 10

    worker_pool = WorkerPool(ContextLogger(logger), 1, {}, 1)
    provider = DebugProvider(None, MagicMock(spec=Logger), worker_pool)
    session = provider.create_session(SESSION_CONFIG, MagicMock(spec=Logger))

    yield session

    session.end_session()
    provider.cleanup_provider()
    worker_pool.shutdown()


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
    debug_provider_session.handle_audio_chunk(chunk)
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
    debug_provider_session.handle_audio_chunk(chunk)
    await asyncio.sleep(1.2)

    # Assert
    assert len(results) == 1
    assert isinstance(results[0], TranscriptionClientError)
