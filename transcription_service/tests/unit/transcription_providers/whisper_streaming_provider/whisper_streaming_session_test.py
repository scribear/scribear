"""
Unit tests for WhisperStreamingProvider.create_session's session_uid/room_uid
storage (Part 1 of the monitoring dashboard plan) and their forwarding to
register_job, which is what surfaces them on /providers/health (Part 2).
"""

from unittest.mock import MagicMock

import pytest

from src.shared.logger import Logger
from src.shared.utils.worker_pool import WorkerPool
from src.transcription_providers.whisper_streaming_provider import (
    WhisperStreamingProvider,
)

WHISPER_TAG = "whisper_context"
SILERO_TAG = "silero_context"
PROVIDER_KEY = "whisper"

PROVIDER_CONFIG = {
    "whisper_context_tag": WHISPER_TAG,
    "silero_context_tag": SILERO_TAG,
    "job_period_ms": 1000,
    "max_buffer_len_sec": 20.0,
    "local_agree_dim": 2,
}


@pytest.fixture
def mock_logger():
    """
    Create a mocked logger instance for tests
    """
    return MagicMock(spec=Logger)


@pytest.fixture
def mock_worker_pool():
    """
    Create a mocked worker pool; register_job returns a MagicMock job.
    """
    return MagicMock(spec=WorkerPool)


@pytest.fixture
def provider(mock_logger: Logger, mock_worker_pool: WorkerPool):
    """
    Create a WhisperStreamingProvider over the mocked pool
    """
    return WhisperStreamingProvider(
        PROVIDER_CONFIG, mock_logger, mock_worker_pool, PROVIDER_KEY
    )


def test_create_session_stores_session_and_room_uid(
    provider: WhisperStreamingProvider, mock_logger: MagicMock
):
    """
    session_uid/room_uid supplied by the caller land on the session object
    """
    # Act
    session = provider.create_session(
        "unused_config", "session-1", "room-1", mock_logger
    )

    # Assert
    assert session.session_uid == "session-1"
    assert session.room_uid == "room-1"


def test_create_session_defaults_to_none_when_absent(
    provider: WhisperStreamingProvider, mock_logger: MagicMock
):
    """
    An older node server sends neither field; the session stores None rather
    than failing.
    """
    # Act
    session = provider.create_session("unused_config", None, None, mock_logger)

    # Assert
    assert session.session_uid is None
    assert session.room_uid is None


def test_create_session_forwards_session_and_room_uid_to_register_job(
    provider: WhisperStreamingProvider,
    mock_logger: MagicMock,
    mock_worker_pool: MagicMock,
):
    """
    session_uid/room_uid reach worker_pool.register_job, which is what makes
    them show up as an ActiveJob on /providers/health
    """
    # Act
    provider.create_session("unused_config", "session-1", "room-1", mock_logger)

    # Assert
    _, kwargs = mock_worker_pool.register_job.call_args
    assert kwargs["session_uid"] == "session-1"
    assert kwargs["room_uid"] == "room-1"
