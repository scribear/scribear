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

from src.shared.config import (
    Config,
    JobContextConfigSchema,
    JobContextDefinitionUID,
    TranscriptionProviderConfigSchema,
    TranscriptionProviderUID,
)
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

NUM_WORKERS = 2
ROLLING_UTILIZATION_WINDOW_SEC = 600
CONTEXT_0 = JobContextConfigSchema(
    context_uid=JobContextDefinitionUID.FASTER_WHISPER,
    max_instances=2,
    tags=["tag0", "tag1"],
    negative_affinity="tag2",
    context_config={"some_key": "some_value"},
)
CONTEXT_1 = JobContextConfigSchema(
    context_uid=JobContextDefinitionUID.FASTER_WHISPER,
    max_instances=1,
    tags=["tag2"],
    negative_affinity=None,
    context_config={"some_key": "other_value"},
)


PROVIDER_0 = TranscriptionProviderConfigSchema(
    provider_key="provider0",
    provider_uid=TranscriptionProviderUID.DEBUG,
    provider_config={"some_key": "some_value"},
)
PROVIDER_1 = TranscriptionProviderConfigSchema(
    provider_key="provider1",
    provider_uid=TranscriptionProviderUID.DEBUG,
    provider_config={"some_key": "other_value"},
)

VALID_PROVIDER_CONFIG_JSON = f"""
{{
    "num_workers": {str(NUM_WORKERS)},
    "rolling_utilization_window_sec": {str(ROLLING_UTILIZATION_WINDOW_SEC)},
    "contexts": [
        {CONTEXT_0.model_dump_json()},
        {CONTEXT_1.model_dump_json()}
    ],
    "providers": [
        {PROVIDER_0.model_dump_json()},
        {PROVIDER_1.model_dump_json()}
    ]
}}"""


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
    transcription_config_path.write_text(VALID_PROVIDER_CONFIG_JSON)

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

    assert config.provider_config.num_workers == NUM_WORKERS
    assert (
        config.provider_config.rolling_utilization_window_sec
        == ROLLING_UTILIZATION_WINDOW_SEC
    )
    assert len(config.provider_config.contexts) == 2
    assert config.provider_config.contexts[0] == CONTEXT_0
    assert config.provider_config.contexts[1] == CONTEXT_1
    assert len(config.provider_config.providers) == 2
    assert config.provider_config.providers[0] == PROVIDER_0
    assert config.provider_config.providers[1] == PROVIDER_1


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
    invalid_config_data = [
        {"provider_config": {"some_key": "some_value"}}  # Missing provider_uid
    ]
    invalid_transcription_config_path.write_text(
        json.dumps(invalid_config_data)
    )

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
    transcription_config_path.write_text(VALID_PROVIDER_CONFIG_JSON)
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
    transcription_config_path.write_text(VALID_PROVIDER_CONFIG_JSON)
    monkeypatch.setattr(sys, "argv", ["main.py"])

    dotenv_path = tmp_path / ".env"
    dotenv_content = valid_env(str(transcription_config_path))
    dotenv_path.write_text(dotenv_content)

    # Act
    config = Config(dotenv_path=str(dotenv_path))

    # Assert
    assert config.is_development is False
