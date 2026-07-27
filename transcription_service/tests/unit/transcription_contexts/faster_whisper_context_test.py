"""
Unit tests for the thread settings FasterWhisperContext hands CTranslate2.

`cpu_threads` is the seam that keeps the images' OMP_NUM_THREADS=1 cap (there
to stop OpenBLAS spawning a spinning thread per core) from also serialising CPU
inference, which faster-whisper's own default - read straight from
OMP_NUM_THREADS - would do: 61.8s against 17.97s for a 30s buffer, measured.
So the value must be chosen here rather than inherited, and a regression is
silent in exactly the way a comment cannot catch - the transcripts stay
byte-identical and only the throughput collapses. Hence a test on the argument.

WhisperModel is patched: this is about what gets passed to CTranslate2, and
loading a real model would need weights, a device, and ~10s per case.
"""

import logging
from unittest.mock import MagicMock, patch

import pytest

from src.shared.logger import ContextLogger
from src.transcription_contexts.faster_whisper_context.faster_whisper_context import (
    DEFAULT_CPU_THREADS,
    FasterWhisperContext,
)


@pytest.fixture
def mock_logger():
    """A logger that records nothing, matching the other unit suites."""
    underlying = MagicMock(spec=logging.Logger)
    underlying.level = 10
    return ContextLogger(underlying)


def create_model(config: dict, mock_logger) -> MagicMock:
    """
    Runs FasterWhisperContext.create with WhisperModel patched out.

    Returns:
        The patched WhisperModel, so callers can assert on its call args.
    """
    context = FasterWhisperContext(config, tags=["t"])
    with patch(
        "src.transcription_contexts.faster_whisper_context."
        "faster_whisper_context.WhisperModel"
    ) as model:
        context.create(mock_logger)
    return model


def test_cpu_device_defaults_to_a_real_thread_pool(mock_logger):
    """
    The cpu device must not inherit the images' OMP_NUM_THREADS=1.
    """
    # Arrange / Act
    model = create_model({"model": "turbo", "device": "cpu"}, mock_logger)

    # Assert
    assert model.call_args.kwargs["cpu_threads"] == DEFAULT_CPU_THREADS
    assert DEFAULT_CPU_THREADS > 1


def test_cuda_device_defaults_to_one_thread(mock_logger):
    """
    Nothing on the cuda path needs a CPU pool - the encoder and decoder are on
    the GPU, and the pool measured as pure contention there (4.59 cores against
    0.99 for one 30s-buffer transcribe, same transcripts, slightly lower
    latency).
    """
    # Arrange / Act
    model = create_model({"model": "turbo", "device": "cuda"}, mock_logger)

    # Assert
    assert model.call_args.kwargs["cpu_threads"] == 1


@pytest.mark.parametrize("device", ["cpu", "cuda"])
def test_explicit_cpu_threads_wins_on_either_device(device, mock_logger):
    """
    A deployment with cores to spare can raise it per context, and the
    device-based default must not quietly override that.
    """
    # Arrange / Act
    model = create_model(
        {"model": "turbo", "device": device, "cpu_threads": 12}, mock_logger
    )

    # Assert
    assert model.call_args.kwargs["cpu_threads"] == 12


def test_compute_type_is_only_passed_when_set(mock_logger):
    """
    Unset must stay absent rather than becoming None: faster-whisper picks a
    device-appropriate default only for an argument it was not given.
    """
    # Arrange / Act
    unset = create_model({"model": "turbo", "device": "cuda"}, mock_logger)
    set_to_float32 = create_model(
        {"model": "turbo", "device": "cuda", "compute_type": "float32"},
        mock_logger,
    )

    # Assert
    assert "compute_type" not in unset.call_args.kwargs
    assert set_to_float32.call_args.kwargs["compute_type"] == "float32"
