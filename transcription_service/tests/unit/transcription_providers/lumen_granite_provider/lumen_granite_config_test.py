"""
Unit tests for LumenGraniteProviderConfig validation
"""

import pytest
from pydantic import ValidationError

from src.transcription_providers.lumen_granite_provider.lumen_granite_config import (
    lumen_granite_config_adapter,
)


def test_defaults_point_at_lumen():
    """
    An empty config validates and defaults to the Lumen Granite endpoint.
    """
    config = lumen_granite_config_adapter.validate_python({})

    assert config.base_url == "https://lumen.ncsa.illinois.edu/v1"
    assert config.request_path == "/audio/transcriptions"
    assert config.model == "granite-speech-4.1-2b-plus"
    assert config.sample_rate == 16000
    assert config.num_channels == 1


def test_overrides_are_accepted():
    """
    Provided fields override the defaults.
    """
    config = lumen_granite_config_adapter.validate_python(
        {
            "base_url": "http://localhost:9000/v1",
            "model": "other-model",
            "api_key_env": "MY_KEY",
            "language": "en",
            "prompt": "context words",
            "job_period_ms": 1000,
            "max_buffer_len_sec": 5,
            "timeout_sec": 12.5,
        }
    )

    assert config.base_url == "http://localhost:9000/v1"
    assert config.model == "other-model"
    assert config.api_key_env == "MY_KEY"
    assert config.language == "en"
    assert config.prompt == "context words"
    assert config.job_period_ms == 1000
    assert config.max_buffer_len_sec == 5
    assert config.timeout_sec == 12.5


def test_rejects_wrong_types():
    """
    Invalid field types raise a pydantic ValidationError.
    """
    with pytest.raises(ValidationError):
        lumen_granite_config_adapter.validate_python(
            {"job_period_ms": "not-a-number"}
        )
