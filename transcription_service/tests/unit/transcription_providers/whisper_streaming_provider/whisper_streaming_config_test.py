"""
Unit tests for WhisperStreamingProviderConfig's bounded-tail split
(`PLAN-AdmissionControl.md` §2): `force_finalize_len_sec` (F) and
`max_transcribe_len_sec` (W) default to `max_buffer_len_sec` when unset, F
must be >= W, and `job_period_ms` must not exceed `max_buffer_len_sec` in
milliseconds.
"""

import pytest
from pydantic import ValidationError

from src.transcription_providers.whisper_streaming_provider.whisper_streaming_config import (
    WhisperStreamingProviderConfig,
)


def make_config(**overrides) -> dict:
    """A minimal valid config dict, overridable per test."""
    config = {
        "whisper_context_tag": "w",
        "silero_context_tag": "s",
        "job_period_ms": 5000,
        "max_buffer_len_sec": 30,
        "local_agree_dim": 2,
    }
    config.update(overrides)
    return config


def test_force_finalize_and_max_transcribe_default_to_max_buffer_len_sec():
    """An upgrade that only sets max_buffer_len_sec is a no-op."""
    config = WhisperStreamingProviderConfig(**make_config())

    assert config.force_finalize_len_sec == 30
    assert config.max_transcribe_len_sec == 30


def test_explicit_force_finalize_and_max_transcribe_are_kept():
    """Setting both explicitly overrides the max_buffer_len_sec default."""
    config = WhisperStreamingProviderConfig(
        **make_config(force_finalize_len_sec=20, max_transcribe_len_sec=10)
    )

    assert config.force_finalize_len_sec == 20
    assert config.max_transcribe_len_sec == 10


def test_force_finalize_below_max_transcribe_is_rejected():
    """F < W would let the tail be force-purged before it is transcribed."""
    with pytest.raises(ValidationError, match="force_finalize_len_sec"):
        WhisperStreamingProviderConfig(
            **make_config(force_finalize_len_sec=5, max_transcribe_len_sec=10)
        )


def test_force_finalize_equal_to_max_transcribe_is_allowed():
    """F == W is the boundary, not the violation - only F < W is rejected."""
    config = WhisperStreamingProviderConfig(
        **make_config(force_finalize_len_sec=10, max_transcribe_len_sec=10)
    )

    assert config.force_finalize_len_sec == 10
    assert config.max_transcribe_len_sec == 10


def test_job_period_exceeding_max_buffer_len_sec_is_rejected():
    """A job scheduled less often than the buffer holds overflows every pass."""
    with pytest.raises(ValidationError, match="job_period_ms"):
        WhisperStreamingProviderConfig(
            **make_config(job_period_ms=5000, max_buffer_len_sec=2)
        )


def test_job_period_equal_to_max_buffer_len_sec_is_allowed():
    """The boundary is allowed - only exceeding it is rejected."""
    config = WhisperStreamingProviderConfig(
        **make_config(job_period_ms=5000, max_buffer_len_sec=5)
    )

    assert config.job_period_ms == 5000
