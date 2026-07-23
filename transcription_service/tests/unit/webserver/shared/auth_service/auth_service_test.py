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


def test_rejects_empty_api_key(mock_config: Config):
    """
    Test auth service refuses to construct with an empty key

    Compose substitutes a blank string for an unset variable, so this is the
    shape a missing API_KEY arrives in. It must not construct: an empty key
    compares equal to the empty string an unauthenticated caller presents.
    """
    # Arrange
    mock_config.api_key = ""

    # Act / Assert
    with pytest.raises(ValueError, match="API_KEY is empty"):
        AuthService(config=mock_config)


@pytest.mark.parametrize(
    "placeholder",
    [
        "CHANGEME",
        # The stubs carrying a length-rule suffix are the ones an equality
        # check would wave through.
        "CHANGEME-JWT-must-be-at-least-32-characters-long",
        "changeme",
    ],
)
def test_rejects_placeholder_api_key(mock_config: Config, placeholder: str):
    """
    Test auth service refuses to construct with an .env.example stub
    """
    # Arrange
    mock_config.api_key = placeholder

    # Act / Assert
    with pytest.raises(ValueError, match="placeholder"):
        AuthService(config=mock_config)
