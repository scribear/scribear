"""
Unit tests for WhisperStreamingProvider.create_session's session_uid/room_uid
storage (Part 1 of the monitoring dashboard plan) and their forwarding to
register_job, which is what surfaces them on /providers/health (Part 2), plus
the capacity-refusal undo (PLAN-AdmissionControl.md §4).
"""

from unittest.mock import MagicMock

import pytest

from src.shared.logger import Logger
from src.shared.utils.worker_pool import WorkerPool
from src.transcription_provider_interface import (
    AT_CAPACITY_REASON,
    TranscriptionCapacityError,
)
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

    Registration is deferred to the first audio chunk (an idle session never
    takes a worker's job slot), so this sends one before asserting on
    register_job's call args.
    """
    # Act
    session = provider.create_session(
        "unused_config", "session-1", "room-1", mock_logger
    )
    session.handle_audio_chunk("chunk-1", b"audio")

    # Assert
    _, kwargs = mock_worker_pool.register_job.call_args
    assert kwargs["session_uid"] == "session-1"
    assert kwargs["room_uid"] == "room-1"


def test_reported_job_period_is_the_one_register_job_receives(
    provider: WhisperStreamingProvider,
    mock_logger: MagicMock,
    mock_worker_pool: MagicMock,
):
    """
    The period reported on /metrics/status is the period actually scheduled

    Reporting it exists to stop the sidecar being told the same number in a
    second file; a re-derivation that could drift from the value passed to
    register_job would reintroduce exactly that failure one layer down.
    """
    # Act
    session = provider.create_session("unused_config", None, None, mock_logger)
    session.handle_audio_chunk("chunk-1", b"audio")

    # Assert
    args, _ = mock_worker_pool.register_job.call_args
    assert provider.job_period_ms == PROVIDER_CONFIG["job_period_ms"]
    assert args[1] == provider.job_period_ms


def test_capacity_refusal_deregisters_the_job_and_reraises(
    provider: WhisperStreamingProvider,
    mock_logger: MagicMock,
    mock_worker_pool: MagicMock,
):
    """
    A session refused on its first chunk must not leak the job it just
    registered

    `_ensure_job` registers before it can know whether the worker has room -
    the pool only decides who owns a worker at `register_job` time - so a
    refusal is always an undo, not a rejection that skips registering at all.
    Left un-deregistered, the worker would keep scheduling a job every period
    for a session no client is attached to, consuming the very capacity the
    refusal exists to protect - invisibly, since nothing else would ever call
    `end_session` on a session the caller never got back.
    """

    # Arrange
    def _always_refuse(worker_id, logger):
        raise TranscriptionCapacityError(AT_CAPACITY_REASON)

    provider.bind_admission_check(_always_refuse)
    session = provider.create_session("unused_config", None, None, mock_logger)
    job_handle = mock_worker_pool.register_job.return_value

    # Act / Assert
    with pytest.raises(TranscriptionCapacityError):
        session.handle_audio_chunk("chunk-1", b"audio")

    job_handle.deregister.assert_called_once()
    assert session.admission_worker_id is None
