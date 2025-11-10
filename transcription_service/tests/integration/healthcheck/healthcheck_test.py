"""
Integration tests for /healthcheck endpoint
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
    mock.provider_config.num_workers = 2
    return mock


@pytest_asyncio.fixture
async def test_client(mock_config: Config, mock_logger: Logger):
    """
    Create fresh FastAPI test client for each test
    """
    with TestClient(create_webserver(mock_config, mock_logger)) as client:
        yield client


def test_healthcheck_integration(test_client: TestClient):
    """
    Test that healthcheck endpoint works
    """
    # Arrange / Act
    response = test_client.get("/healthcheck")

    # Assert
    assert response.status_code == 200
