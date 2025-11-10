"""
Unit tests for AuthService
"""

from unittest.mock import MagicMock

import pytest

from src.shared.config import Config
from src.webserver.shared.auth_service import AuthService

API_KEY = "secret-test-key-12345"


@pytest.fixture
def mock_config():
    """
    Pytest fixture to create a mock config object for tests.
    """
    mock = MagicMock(spec=Config)
    mock.api_key = API_KEY
    return mock


def test_is_authenticated_with_correct_key(mock_config: Config):
    """
    Test auth service accepts correct key
    """
    # Arrange
    auth_service = AuthService(config=mock_config)

    # Act
    is_auth = auth_service.is_authenticated(API_KEY)

    # Assert
    assert is_auth is True


def test_is_authenticated_with_incorrect_key(mock_config: Config):
    """
    Test auth service rejects incorrect key
    """
    # Arrange
    auth_service = AuthService(config=mock_config)

    # Act
    is_auth = auth_service.is_authenticated("not-the-key")

    # Assert
    assert is_auth is False
