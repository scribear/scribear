"""
Unit tests for Config
"""

import json
import os
import socket
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
METRICS_API_KEY = "SOME_METRICS_KEY"
WS_INIT_TIMEOUT_SEC = 0.5
AUDIO_SILENCE_THRESHOLD = 0.05
TARGET_BUSY = 0.75
MIN_SESSIONS = 2
MAX_SESSIONS = 4

valid_env: Callable[[str], str] = lambda provider_config_path: f"""
LOG_LEVEL={LOG_LEVEL}
PORT={PORT}
HOST={HOST}
API_KEY={API_KEY}
WS_INIT_TIMEOUT_SEC={WS_INIT_TIMEOUT_SEC}
PROVIDER_CONFIG_PATH={provider_config_path}
"""

NUM_WORKERS = 2
CONTEXT_0 = JobContextConfigSchema(
    context_uid=JobContextDefinitionUID.FASTER_WHISPER,
    worker_ids=[0, 1],
    tags=["tag0", "tag1"],
    context_config={"some_key": "some_value"},
)
CONTEXT_1 = JobContextConfigSchema(
    context_uid=JobContextDefinitionUID.FASTER_WHISPER,
    worker_ids=[1],
    tags=["tag2"],
    context_config={"some_key": "other_value"},
)


PROVIDER_0 = TranscriptionProviderConfigSchema(
    provider_uid=TranscriptionProviderUID.DEBUG,
    provider_config={"some_key": "some_value"},
)
PROVIDER_1 = TranscriptionProviderConfigSchema(
    provider_uid=TranscriptionProviderUID.DEBUG,
    provider_config={"some_key": "other_value"},
)

VALID_PROVIDER_CONFIG_JSON = f"""
{{
    "num_workers": {str(NUM_WORKERS)},
    "contexts": [
        {CONTEXT_0.model_dump_json()},
        {CONTEXT_1.model_dump_json()}
    ],
    "providers": {{
        "provider0": {PROVIDER_0.model_dump_json()},
        "provider1": {PROVIDER_1.model_dump_json()}
    }}
}}"""


@pytest.fixture
def clean_os_environ():
    """
    A fixture to ensure os.environ is empty during the test and restored after

    Config reads every setting straight from os.environ, so a variable
    already present in the shell participates in a test that is supposed to
    be driven only by the .env file under tmp_path, and dotenv does not
    override an existing variable. This is not theoretical: the production
    image sets PROVIDER_CONFIG_PATH, HOST and PORT as Docker ENV, and without
    the clear() below every test in this module that builds a Config fails
    when run in that image even though it passes on a bare dev shell.
    """
    original_environ = os.environ.copy()
    os.environ.clear()

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
    # Absent from the .env above on purpose: the metrics key must stay
    # optional, or adding it would break every existing deployment.
    assert config.metrics_api_key == ""
    # Same reasoning for the telemetry backplane: unset means publishing off
    # and no connection at all, and the host identity falls back to the
    # hostname so an unconfigured deployment still has a stable one.
    assert config.redis_url == ""
    assert config.transcription_host_id == socket.gethostname()
    # Same again for the ingress meter's silence floor: the shipped default has
    # to be the 0.01 AudioMeter and whisper's own threshold already used, or
    # adding the variable would silently reclassify what counts as silence on
    # every existing deployment.
    assert config.audio_silence_threshold == 0.01
    # Same again for the capacity estimator's manual override
    # (archived-plans/2026-07-27-02-PLAN-AdmissionControl.md §3): the shipped
    # defaults must apply with none of the three set, or adding them would
    # change every existing deployment's admitted capacity out from under it.
    assert config.target_busy == 0.85
    assert config.min_sessions == 1
    assert config.max_sessions is None

    assert config.provider_config.num_workers == NUM_WORKERS
    assert len(config.provider_config.contexts) == 2
    assert config.provider_config.contexts[0] == CONTEXT_0
    assert config.provider_config.contexts[1] == CONTEXT_1
    assert len(config.provider_config.providers) == 2
    assert config.provider_config.providers["provider0"] == PROVIDER_0
    assert config.provider_config.providers["provider1"] == PROVIDER_1


def test_config_loads_metrics_api_key_when_set(
    clean_os_environ: None, tmp_path: Path
):
    # pylint: disable=unused-argument
    # Need to include clean_os_environ so that fixture is created
    """
    Test that a configured metrics key is read

    It is a separate secret from API_KEY: that one opens transcription
    sessions, this one only reads counters.
    """
    # Arrange
    transcription_config_path = tmp_path / "transcription_config.json"
    transcription_config_path.write_text(VALID_PROVIDER_CONFIG_JSON)

    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text(
        valid_env(str(transcription_config_path))
        + f"METRICS_API_KEY={METRICS_API_KEY}\n"
    )

    # Act
    config = Config(dotenv_path=str(dotenv_path))

    # Assert
    assert config.metrics_api_key == METRICS_API_KEY
    assert config.api_key == API_KEY


def test_config_loads_telemetry_settings_when_set(
    clean_os_environ: None, tmp_path: Path
):
    # pylint: disable=unused-argument
    # Need to include clean_os_environ so that fixture is created
    """
    Test a configured backplane URL and host identity are read

    Both gate fleet telemetry publishing; neither touches the transcription
    path.
    """
    # Arrange
    transcription_config_path = tmp_path / "transcription_config.json"
    transcription_config_path.write_text(VALID_PROVIDER_CONFIG_JSON)

    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text(
        valid_env(str(transcription_config_path))
        + "REDIS_URL=redis://:secret@redis:6379\n"
        + "TRANSCRIPTION_HOST_ID=ts-host-7\n"
    )

    # Act
    config = Config(dotenv_path=str(dotenv_path))

    # Assert
    assert config.redis_url == "redis://:secret@redis:6379"
    assert config.transcription_host_id == "ts-host-7"


def test_config_loads_the_audio_silence_threshold_when_set(
    clean_os_environ: None, tmp_path: Path
):
    # pylint: disable=unused-argument
    # Need to include clean_os_environ so that fixture is created
    """
    Test a configured silence floor is read

    The number is room-dependent - a hall with loud HVAC never falls under the
    default and so never reports a dead microphone as silent - and the ingress
    meter has no provider config to read it from, which is the whole reason it
    is an env var (§12.7).
    """
    # Arrange
    transcription_config_path = tmp_path / "transcription_config.json"
    transcription_config_path.write_text(VALID_PROVIDER_CONFIG_JSON)

    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text(
        valid_env(str(transcription_config_path))
        + f"AUDIO_SILENCE_THRESHOLD={AUDIO_SILENCE_THRESHOLD}\n"
    )

    # Act
    config = Config(dotenv_path=str(dotenv_path))

    # Assert
    assert config.audio_silence_threshold == AUDIO_SILENCE_THRESHOLD


def test_config_loads_the_capacity_estimator_overrides_when_set(
    clean_os_environ: None, tmp_path: Path
):
    # pylint: disable=unused-argument
    # Need to include clean_os_environ so that fixture is created
    """
    Test configured capacity estimator overrides are read
    (archived-plans/2026-07-27-02-PLAN-AdmissionControl.md §3)

    All three are the manual override the plan calls out by name - headroom,
    floor and operator pin - and none of them require touching the provider
    config file to reach, unlike the compose-only knobs this subsystem has
    already regretted shipping that way.
    """
    # Arrange
    transcription_config_path = tmp_path / "transcription_config.json"
    transcription_config_path.write_text(VALID_PROVIDER_CONFIG_JSON)

    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text(
        valid_env(str(transcription_config_path))
        + f"TARGET_BUSY={TARGET_BUSY}\n"
        + f"MIN_SESSIONS={MIN_SESSIONS}\n"
        + f"MAX_SESSIONS={MAX_SESSIONS}\n"
    )

    # Act
    config = Config(dotenv_path=str(dotenv_path))

    # Assert
    assert config.target_busy == TARGET_BUSY
    assert config.min_sessions == MIN_SESSIONS
    assert config.max_sessions == MAX_SESSIONS


def test_config_reads_a_blank_max_sessions_as_no_pin(
    clean_os_environ: None, tmp_path: Path
):
    # pylint: disable=unused-argument
    # Need to include clean_os_environ so that fixture is created
    """
    Test an empty MAX_SESSIONS leaves the estimator auto-tuning

    This is what every stock compose deployment sends. `compose.yml` cannot
    omit an environment key, so it passes
    `MAX_SESSIONS: ${TRANSCRIPTION_MAX_SESSIONS:-}` and an operator who never
    sets the variable hands the service an empty string rather than nothing at
    all. `int | None` refuses to parse that, so without the coercion the whole
    container fails to boot - an optional tuning knob becoming a required one
    for everyone who copied the shipped file.

    The other two need no equivalent: they carry real literal defaults in
    compose, so they are never blank.
    """
    # Arrange
    transcription_config_path = tmp_path / "transcription_config.json"
    transcription_config_path.write_text(VALID_PROVIDER_CONFIG_JSON)

    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text(
        valid_env(str(transcription_config_path)) + "MAX_SESSIONS=\n"
    )

    # Act
    config = Config(dotenv_path=str(dotenv_path))

    # Assert - identical to leaving the variable out entirely
    assert config.max_sessions is None
    assert config.target_busy == 0.85
    assert config.min_sessions == 1


def test_config_still_rejects_an_unparseable_max_sessions(
    clean_os_environ: None, tmp_path: Path
):
    # pylint: disable=unused-argument
    # Need to include clean_os_environ so that fixture is created
    """
    Test a non-numeric MAX_SESSIONS stops the process rather than being ignored

    The blank coercion above is deliberately narrow. Falling back to
    auto-tuning on any unparseable value would leave an operator who typed
    `MAX_SESSIONS=lots` believing they had pinned the ceiling while the
    estimator quietly went on measuring one - a misconfiguration with no
    symptom to find.
    """
    # Arrange
    transcription_config_path = tmp_path / "transcription_config.json"
    transcription_config_path.write_text(VALID_PROVIDER_CONFIG_JSON)

    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text(
        valid_env(str(transcription_config_path)) + "MAX_SESSIONS=lots\n"
    )

    # Act / Assert
    with pytest.raises(ValidationError):
        Config(dotenv_path=str(dotenv_path))


def test_config_rejects_a_host_id_that_could_forge_a_telemetry_key(
    clean_os_environ: None, tmp_path: Path
):
    # pylint: disable=unused-argument
    # Need to include clean_os_environ so that fixture is created
    """
    Test a ':' in the host identity is refused at boot

    It is interpolated into `scribe:v1:ts:{host}`, so a value containing ':'
    could write over another part of the telemetry namespace. Rejecting it at
    config load fails the process once rather than every heartbeat.
    """
    # Arrange
    transcription_config_path = tmp_path / "transcription_config.json"
    transcription_config_path.write_text(VALID_PROVIDER_CONFIG_JSON)

    dotenv_path = tmp_path / ".env"
    dotenv_path.write_text(
        valid_env(str(transcription_config_path))
        + "TRANSCRIPTION_HOST_ID=host:with:colons\n"
    )

    # Act / Assert
    with pytest.raises(ValidationError):
        Config(dotenv_path=str(dotenv_path))


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
