"""
Unit tests for LumenGraniteProvider.create_session's session_uid/room_uid
storage (Part 1 of the monitoring dashboard plan) and their forwarding to
register_job, which is what surfaces them on /providers/health (Part 2).
"""

from unittest.mock import MagicMock

import pytest

from src.shared.logger import Logger
from src.shared.utils.worker_pool import WorkerPool
from src.transcription_providers.lumen_granite_provider import (
    LumenGraniteProvider,
)

API_KEY_ENV = "TEST_LUMEN_API_KEY"
BASE_URL = "https://lumen.example.invalid/v1"
PROVIDER_KEY = "lumen_granite"


@pytest.fixture
def mock_logger():
    """
    Create a mocked logger instance for tests
    """
    return MagicMock(spec=Logger)


@pytest.fixture
def mock_worker_pool():
    """
    Create a mocked worker pool; remote providers never route to it
    """
    return MagicMock(spec=WorkerPool)


@pytest.fixture
def provider(mock_logger: Logger, mock_worker_pool: WorkerPool):
    """
    Create a LumenGraniteProvider pointed at an unroutable test endpoint
    """
    return LumenGraniteProvider(
        {"base_url": BASE_URL, "api_key_env": API_KEY_ENV},
        mock_logger,
        mock_worker_pool,
        PROVIDER_KEY,
    )


def test_create_session_stores_session_and_room_uid(
    provider: LumenGraniteProvider, mock_logger: MagicMock
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
    provider: LumenGraniteProvider, mock_logger: MagicMock
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
    provider: LumenGraniteProvider,
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
