"""
Integration tests for /probes/* endpoints
"""

import logging
from unittest.mock import MagicMock

import pytest
import pytest_asyncio
from fastapi.testclient import TestClient

from src.shared.config import Config
from src.shared.logger import ContextLogger, Logger
from src.webserver.create_webserver import create_webserver


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
    mock.provider_config.num_workers = 2
    return mock


@pytest_asyncio.fixture
async def test_client(mock_config: Config, mock_logger: Logger):
    """
    Create fresh FastAPI test client for each test
    """
    with TestClient(create_webserver(mock_config, mock_logger)) as client:
        yield client


@pytest.mark.timeout(3)
def test_liveness_returns_ok(test_client: TestClient):
    """
    Test that liveness endpoint returns 200 with ok status
    """
    # Arrange / Act
    response = test_client.get("/probes/liveness")

    # Assert
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


@pytest.mark.timeout(3)
def test_readiness_returns_ok(test_client: TestClient):
    """
    Test that readiness endpoint returns 200 with ok status when ready
    """
    # Arrange / Act
    response = test_client.get("/probes/readiness")

    # Assert
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
