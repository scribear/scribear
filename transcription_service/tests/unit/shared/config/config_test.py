"""
Unit tests for Config
"""

import json
import os
import sys
from pathlib import Path
from typing import Callable

import pytest
from pydantic import ValidationError

from src.shared.config import Config
from src.shared.logger import LogLevel

LOG_LEVEL = LogLevel.DEBUG
PORT = 12345
HOST = "1.2.3.4"
API_KEY = "SOME_KEY"
WS_INIT_TIMEOUT_SEC = 0.5

valid_env: Callable[[str], str] = (
    lambda provider_config_path: f"""
LOG_LEVEL={LOG_LEVEL}
PORT={PORT}
HOST={HOST}
API_KEY={API_KEY}
WS_INIT_TIMEOUT_SEC={WS_INIT_TIMEOUT_SEC}
PROVIDER_CONFIG_PATH={provider_config_path}
"""
)


@pytest.fixture
def clean_os_environ():
    """
    A fixture to ensure os.environ is reset to original state after each test
    """
    original_environ = os.environ.copy()

    yield

    os.environ.clear()
    os.environ.update(original_environ)


def test_config_load_valid_config(clean_os_environ: None, tmp_path: Path):
    # pylint: disable=unused-argument
    # Need to include clean_os_environ so that fixture is created
    """
    Test that config loads valid configuration files
    """
    # Arrange
    transcription_config_path = tmp_path / "transcription_config.json"

    dotenv_path = tmp_path / ".env"
    dotenv_content = valid_env(str(transcription_config_path))
    dotenv_path.write_text(dotenv_content)

    # Act
    config = Config(dotenv_path=str(dotenv_path))

    # Assert
    assert config.log_level == LOG_LEVEL
    assert config.port == PORT
    assert config.host == HOST
    assert config.api_key == API_KEY
    assert config.ws_init_timeout_sec == WS_INIT_TIMEOUT_SEC


def test_config_invalid_transcription_file(
    clean_os_environ: None, tmp_path: Path
):
    # pylint: disable=unused-argument
    # Need to include clean_os_environ so that fixture is created
    """
    Tests that a Pydantic ValidationError is raised when the .env file is valid
    but the transcription config file has an invalid schema (e.g., missing a required field).
    """
    # Arrange
    invalid_transcription_config_path = tmp_path / "invalid_transcription.json"

    dotenv_path = tmp_path / ".env"
    dotenv_content = valid_env(str(invalid_transcription_config_path))
    dotenv_path.write_text(dotenv_content)

    # Act / Assert
    with pytest.raises(ValidationError):
        Config(dotenv_path=str(dotenv_path))


@pytest.mark.parametrize(
    "invalid_dotenv",
    [
        # Missing a required environment variable (API_KEY)
        """
PORT=8000
HOST=127.0.0.1
WS_INIT_TIMEOUT_SEC=5
TRANSCRIPTION_CONFIG_PATH=/tmp/dummy.json
        """,
        # Invalid value for a variable (PORT)
        """
PORT=not-a-number
HOST=127.0.0.1
API_KEY=my-key
WS_INIT_TIMEOUT_SEC=5
TRANSCRIPTION_CONFIG_PATH=/tmp/dummy.json
        """,
        # Invalid value for IP address
        """
PORT=9000
HOST=not-an-ip-address
API_KEY=my-key
WS_INIT_TIMEOUT_SEC=5
TRANSCRIPTION_CONFIG_PATH=/tmp/dummy.json
        """,
    ],
)
def test_config_invalid_dotenv_file(
    clean_os_environ: None, tmp_path: Path, invalid_dotenv: str
):
    # pylint: disable=unused-argument
    # Need to include clean_os_environ so that fixture is created
    """
    Tests that a Pydantic ValidationError is raised for various invalid .env file contents,
    such as missing required fields or fields with incorrect data types.
    """
    # Arrange
    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text(invalid_dotenv)

    # Act / Assert
    with pytest.raises(ValidationError):
        Config(dotenv_path=str(dotenv_path))


def test_config_is_development_true(
    tmp_path: Path, clean_os_environ: None, monkeypatch: pytest.MonkeyPatch
):
    # pylint: disable=unused-argument
    # Need to include clean_os_environ so that fixture is created
    """
    Test that is_development is True when --dev flag is set
    """
    # Arrange
    transcription_config_path = tmp_path / "transcription_config.json"
    monkeypatch.setattr(sys, "argv", ["main.py", "--dev"])

    dotenv_path = tmp_path / ".env"
    dotenv_content = valid_env(str(transcription_config_path))
    dotenv_path.write_text(dotenv_content)

    # Act
    config = Config(dotenv_path=str(dotenv_path))

    # Assert
    assert config.is_development is True


def test_config_is_development_false(
    tmp_path: Path, clean_os_environ: None, monkeypatch: pytest.MonkeyPatch
):
    # pylint: disable=unused-argument
    # Need to include clean_os_environ so that fixture is created
    """
    Test that is_development is False when --dev flag is not set
    """
    # Arrange
    transcription_config_path = tmp_path / "transcription_config.json"
    monkeypatch.setattr(sys, "argv", ["main.py"])

    dotenv_path = tmp_path / ".env"
    dotenv_content = valid_env(str(transcription_config_path))
    dotenv_path.write_text(dotenv_content)

    # Act
    config = Config(dotenv_path=str(dotenv_path))

    # Assert
    assert config.is_development is False
