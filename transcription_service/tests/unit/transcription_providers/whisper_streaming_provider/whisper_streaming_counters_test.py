"""
Unit tests for the worker-side counters WhisperStreamingProviderJob reports.

These events all happen inside the spawned worker process, so a counter
incremented here is invisible to the process that serves /metrics/status until
it rides back on a job result. The Whisper model is mocked - the counters are
bookkeeping around transcription, not transcription itself.
"""

import io
import logging
from unittest.mock import MagicMock

import numpy as np
import pytest
import soundfile as sf

from src.transcription_provider_interface import (
    AudioChunkPayload,
    TranscriptionClientError,
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
    """A job with a minimal valid config (VAD disabled by default)."""
    config = {
        "whisper_context_tag": "w",
        "silero_context_tag": "s",
        "job_period_ms": 5000,
        "max_buffer_len_sec": 2,
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


@pytest.fixture(name="contexts")
def contexts_fixture():
    """A Whisper model that transcribes nothing, plus a VAD stand-in."""
    whisper = MagicMock()
    whisper.transcribe.return_value = ([], None)
    return (whisper, MagicMock())


def test_counts_audio_ingested_in_seconds(log, contexts):
    """Decoded audio is counted in seconds, not samples."""
    job = make_job()

    job.process_batch(log, contexts, [chunk(1.5)])

    counters = job.drain_counters()
    assert counters[TranscriptionJobCounter.AUDIO_SECONDS_DECODED] == 1.5


def test_counts_no_words_when_nothing_is_transcribed(log, contexts):
    """A non-empty buffer that yields no words is counted.

    The log line for this is INFO, but a count is what an alert can be built
    on - a persistent no-words rate is a dead or misrouted microphone.
    """
    job = make_job()

    job.process_batch(log, contexts, [chunk(0.5)])

    assert job.drain_counters()[TranscriptionJobCounter.NO_WORDS] == 1


def test_counts_buffer_overflow_and_the_audio_it_discarded(log, contexts):
    """Overflowing the buffer counts both the event and the seconds lost.

    The count alone does not say how much audio was force-finalized, which is
    the part that actually degrades the transcript.
    """
    job = make_job(max_buffer_len_sec=1)

    # 1.5s into a 1s buffer: 0.5s must be force-finalized out.
    job.process_batch(log, contexts, [chunk(1.5)])

    counters = job.drain_counters()
    assert counters[TranscriptionJobCounter.BUFFER_OVERFLOW] == 1
    assert counters[
        TranscriptionJobCounter.BUFFER_OVERFLOW_SECONDS
    ] == pytest.approx(0.5)


def test_counts_vad_no_speech(log):
    """A VAD pass that finds no speech at all is counted.

    Its log line is DEBUG, so at the default production log level this counter
    is the only form of the signal that exists.
    """
    job = make_job(vad_detector=True)
    vad = MagicMock()
    vad.detect_speech_ranges.return_value = []

    job.process_batch(log, (MagicMock(), vad), [chunk(0.5)])

    assert job.drain_counters()[TranscriptionJobCounter.VAD_NO_SPEECH] == 1


def test_counts_audio_too_fast_before_raising(log, contexts):
    """Overrunning the buffer counts the event, not just raises.

    The buffer is sized at twice max_buffer_len_sec, so a chunk past that
    overruns it in one call. This is the only place audio-too-fast is
    observable, which is why the drain has to happen on the failure path.
    """
    job = make_job(max_buffer_len_sec=1)

    with pytest.raises(TranscriptionClientError):
        job.process_batch(log, contexts, [chunk(5)])

    assert job.drain_counters()[TranscriptionJobCounter.AUDIO_TOO_FAST] == 1


def test_drain_resets_between_executions(log, contexts):
    """Counters are per-execution deltas, never running totals."""
    job = make_job()

    job.process_batch(log, contexts, [chunk(0.5)])
    job.drain_counters()

    assert not job.drain_counters()
