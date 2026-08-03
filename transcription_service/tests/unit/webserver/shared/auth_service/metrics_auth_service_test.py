"""
Unit tests for MetricsAuthService
"""

from unittest.mock import MagicMock

import pytest

from src.shared.config import Config
from src.webserver.shared.auth_service import MetricsAuthService

METRICS_API_KEY = "metrics-test-key-12345"
API_KEY = "session-test-key-67890"


@pytest.fixture
def mock_config():
    """
    Pytest fixture to create a mock config object for tests.
    """
    mock = MagicMock(spec=Config)
    mock.api_key = API_KEY
    mock.metrics_api_key = METRICS_API_KEY
    return mock


def test_accepts_correct_bearer_credential(mock_config: Config):
    """
    Test a well formed bearer header carrying the configured key is accepted
    """
    # Arrange
    auth_service = MetricsAuthService(config=mock_config)

    # Act / Assert
    assert auth_service.is_authenticated(f"Bearer {METRICS_API_KEY}") is True


def test_rejects_incorrect_key(mock_config: Config):
    """
    Test a bearer header carrying the wrong key is rejected
    """
    # Arrange
    auth_service = MetricsAuthService(config=mock_config)

    # Act / Assert
    assert auth_service.is_authenticated("Bearer not-the-key") is False


def test_rejects_the_session_api_key(mock_config: Config):
    """
    Test the key that opens transcription sessions does not read metrics

    This separation is the whole point of the second secret: the sidecar has a
    Docker socket mounted, and its credential must not also open ASR sessions.
    """
    # Arrange
    auth_service = MetricsAuthService(config=mock_config)

    # Act / Assert
    assert auth_service.is_authenticated(f"Bearer {API_KEY}") is False


def test_rejects_missing_header(mock_config: Config):
    """
    Test an absent Authorization header is rejected
    """
    # Arrange
    auth_service = MetricsAuthService(config=mock_config)

    # Act / Assert
    assert auth_service.is_authenticated(None) is False


@pytest.mark.parametrize(
    "header",
    [
        METRICS_API_KEY,
        f"bearer {METRICS_API_KEY}",
        f"Basic {METRICS_API_KEY}",
        f"Bearer  {METRICS_API_KEY}",
        "Bearer ",
        "",
    ],
)
def test_rejects_malformed_header(mock_config: Config, header: str):
    """
    Test only the exact `Bearer <key>` form is accepted

    A bare key or a differently cased scheme is a client bug; accepting it
    would make the contract ambiguous for every future consumer.
    """
    # Arrange
    auth_service = MetricsAuthService(config=mock_config)

    # Act / Assert
    assert auth_service.is_authenticated(header) is False


def test_reports_disabled_when_no_key_is_configured():
    """
    Test an unset key disables the endpoint rather than leaving it open

    Callers use is_enabled to decide whether to register the route at all, so
    a disabled endpoint 404s instead of looking like a bad credential.
    """
    # Arrange
    mock = MagicMock(spec=Config)
    mock.metrics_api_key = ""
    auth_service = MetricsAuthService(config=mock)

    # Act / Assert
    assert auth_service.is_enabled is False
    assert auth_service.is_authenticated("Bearer ") is False
    assert auth_service.is_authenticated("Bearer anything") is False


def test_reports_enabled_when_a_key_is_configured(mock_config: Config):
    """
    Test a configured key enables the endpoint
    """
    assert MetricsAuthService(config=mock_config).is_enabled is True
