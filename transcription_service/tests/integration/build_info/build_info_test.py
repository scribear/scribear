"""
Integration tests for the /build-info endpoint
"""

import logging
from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

from src.shared.config import Config
from src.shared.logger import ContextLogger, Logger
from src.webserver.create_webserver import create_webserver

BUILD_ENV = {
    "SCRIBEAR_BUILD_SERVICE": "transcription-service",
    "SCRIBEAR_BUILD_VERSION": "0.2.0",
    "SCRIBEAR_BUILD_COMMIT": "def6e68",
    "SCRIBEAR_BUILD_REF": "staging",
    "SCRIBEAR_BUILD_TIME": "2026-07-24T12:03:11Z",
    "SCRIBEAR_BUILD_TAGS": "staging,staging-def6e68",
    "SCRIBEAR_BUILD_ORIGIN": "ci",
    "SCRIBEAR_BUILD_PR": "",
}


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
    Create mock config object for testing
    """
    mock = MagicMock(spec=Config)
    # Telemetry publishing off: a MagicMock's `redis_url` is otherwise a truthy
    # mock, which sends the lifespan into opening a Redis connection to a
    # nonsense URL and hangs startup.
    mock.redis_url = ""
    # Real numbers, not a MagicMock: create_webserver feeds these straight
    # into CapacityEstimator's ratchet, which does arithmetic on them the
    # moment a worker leaves warm-up.
    mock.target_busy = 0.85
    mock.min_sessions = 1
    mock.max_sessions = None
    mock.provider_config.num_workers = 2
    return mock


@pytest_asyncio.fixture
async def test_client(
    mock_config: Config, mock_logger: Logger, monkeypatch: pytest.MonkeyPatch
):
    """
    Create fresh FastAPI test client for each test

    The build variables are set before the app is created, deliberately: the
    route reads them once at registration, because they are baked into the
    image and cannot change while the process lives.
    """
    for name, value in BUILD_ENV.items():
        monkeypatch.setenv(name, value)

    with TestClient(create_webserver(mock_config, mock_logger)) as client:
        yield client


@pytest.mark.timeout(3)
def test_build_info_reports_the_build_the_image_was_made_from(
    test_client: TestClient,
):
    """
    Test that /build-info answers the stack's shared build document

    The key names are asserted in full because they cross a language boundary:
    admin-server parses this with the same TypeScript type it uses for the Node
    services' responses, so a rename on this side is a silent blank row there.
    """
    # Arrange / Act
    response = test_client.get("/build-info")

    # Assert
    assert response.status_code == 200
    assert response.json() == {
        "service": "transcription-service",
        "version": "0.2.0",
        "commit": "def6e68",
        "ref": "staging",
        "builtAt": "2026-07-24T12:03:11Z",
        "imageTags": ["staging", "staging-def6e68"],
        "pullRequest": None,
        "origin": "ci",
        "dirty": False,
    }


@pytest.mark.timeout(3)
def test_build_info_needs_no_credentials(test_client: TestClient):
    """
    Test that /build-info is unauthenticated, like /probes/*

    Unlike /metrics/* and /providers/health it names no provider, endpoint or
    key, and nginx proxies nothing on this service to the outside - so it is
    reachable only from inside the compose network.
    """
    # Arrange / Act
    response = test_client.get("/build-info", headers={})

    # Assert
    assert response.status_code == 200
