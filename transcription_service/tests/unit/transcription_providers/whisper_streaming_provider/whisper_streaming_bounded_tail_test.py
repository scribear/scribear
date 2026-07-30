"""
Unit tests for the bounded-tail split
(`archived-plans/2026-07-27-02-PLAN-AdmissionControl.md` §2):
`_transcribe_audio` hands Whisper only the oldest `max_transcribe_len_sec`
(W) seconds of the buffer, front-anchored, and force-finalization still
purges the buffer back down to `force_finalize_len_sec` (F) - independently
of W, and even when W < F.

The Whisper model is mocked; these tests are about what audio reaches it and
how much of the buffer survives a pass, not transcription itself.
"""

# pylint: disable=protected-access

import io
import logging
from unittest.mock import MagicMock

import numpy as np
import pytest
import soundfile as sf

from src.transcription_provider_interface import (
    AudioChunkPayload,
    TranscriptionJobCounter,
)
from src.transcription_providers.whisper_streaming_provider.whisper_streaming_config import (
    WhisperStreamingProviderConfig,
)
from src.transcription_providers.whisper_streaming_provider.whisper_streaming_job import (
    SAMPLE_RATE,
    WhisperStreamingProviderJob,
)


def make_job(**overrides) -> WhisperStreamingProviderJob:
    """A job with a minimal valid config; F and W both default to
    max_buffer_len_sec unless overridden."""
    config = {
        "whisper_context_tag": "w",
        "silero_context_tag": "s",
        "job_period_ms": 500,
        "max_buffer_len_sec": 30,
        "local_agree_dim": 2,
    }
    config.update(overrides)
    return WhisperStreamingProviderJob(WhisperStreamingProviderConfig(**config))


def chunk(seconds: float, chunk_id: str = "a") -> AudioChunkPayload:
    """Wrap `seconds` of silence as a mono 16-bit WAV chunk payload."""
    samples = np.zeros(int(SAMPLE_RATE * seconds), dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, samples, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return AudioChunkPayload(chunk_id=chunk_id, audio_bytes=buf.getvalue())


@pytest.fixture(name="log")
def log_fixture():
    """A logger stub that swallows calls."""
    return MagicMock(spec=logging.Logger)


@pytest.fixture(name="whisper")
def whisper_fixture():
    """A Whisper model that transcribes nothing, capturing what it was fed."""
    model = MagicMock()
    model.transcribe.return_value = ([], None)
    return model


def test_transcribe_covers_only_the_oldest_w_seconds_of_a_longer_tail(
    log, whisper
):
    """A buffer holding more than W seconds is windowed to the front W."""
    job = make_job(max_buffer_len_sec=30, max_transcribe_len_sec=5)

    # 10s in one batch: well under the 30s buffer/force-finalize cap, but
    # twice the 5s transcribe window.
    job.process_batch(log, (whisper, MagicMock()), [chunk(10)])

    assert (
        job.drain_counters().get(TranscriptionJobCounter.BUFFER_OVERFLOW, 0)
        == 0
    )
    (audio_chunk,), _ = whisper.transcribe.call_args
    assert audio_chunk.shape[0] == 5 * SAMPLE_RATE


def test_transcribe_covers_the_whole_buffer_when_shorter_than_w(log, whisper):
    """W is a ceiling, not a fixed size - a shorter buffer is not padded."""
    job = make_job(max_buffer_len_sec=30, max_transcribe_len_sec=5)

    job.process_batch(log, (whisper, MagicMock()), [chunk(2)])

    (audio_chunk,), _ = whisper.transcribe.call_args
    assert audio_chunk.shape[0] == 2 * SAMPLE_RATE


def test_force_finalize_still_purges_at_f_independent_of_w(log, whisper):
    """F, not W, governs when the buffer is force-purged.

    A 15s batch into an F=10s/W=5s job must force-finalize 5s out (15 - 10),
    the same as it would with W unset - the transcribe window bounds Whisper's
    per-pass cost, it does not change the force-finalize threshold.
    """
    job = make_job(
        max_buffer_len_sec=30,
        force_finalize_len_sec=10,
        max_transcribe_len_sec=5,
    )

    job.process_batch(log, (whisper, MagicMock()), [chunk(15)])

    counters = job.drain_counters()
    assert counters[TranscriptionJobCounter.BUFFER_OVERFLOW] == 1
    assert counters[
        TranscriptionJobCounter.BUFFER_OVERFLOW_SECONDS
    ] == pytest.approx(5.0)
    assert len(job._buffer) == 10 * SAMPLE_RATE


def test_force_finalize_purges_to_f_even_when_it_exceeds_w(log, whisper):
    """F > W is the normal, expected case (bounded transcribe cost under a
    longer backlog tolerance) - the buffer settles at F, not W."""
    job = make_job(
        max_buffer_len_sec=30,
        force_finalize_len_sec=10,
        max_transcribe_len_sec=3,
    )

    job.process_batch(log, (whisper, MagicMock()), [chunk(12)])

    assert len(job._buffer) == 10 * SAMPLE_RATE
    (audio_chunk,), _ = whisper.transcribe.call_args
    assert audio_chunk.shape[0] == 3 * SAMPLE_RATE
