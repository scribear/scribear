"""
Unit tests for WhisperStreamingProviderJob chunk-id ledger and latency
correlation. Exercises the pure bookkeeping (which chunk ids a transcript end
time maps to, and ledger pruning) without invoking the Whisper model.
"""

# pylint: disable=protected-access

import io
import logging
from unittest.mock import MagicMock

import numpy as np
import soundfile as sf

from src.transcription_provider_interface import (
    AudioChunkPayload,
    TranscriptionSequence,
)
from src.transcription_providers.whisper_streaming_provider.whisper_streaming_config import (
    WhisperStreamingProviderConfig,
)
from src.transcription_providers.whisper_streaming_provider.whisper_streaming_job import (
    SAMPLE_RATE,
    WhisperStreamingProviderJob,
)


def make_job() -> WhisperStreamingProviderJob:
    """A job with a minimal valid config (VAD disabled)."""
    config = WhisperStreamingProviderConfig(
        whisper_context_tag="w",
        silero_context_tag="s",
        job_period_ms=5000,
        max_buffer_len_sec=30,
        local_agree_dim=2,
    )
    return WhisperStreamingProviderJob(config)


def _one_second_ledger():
    """Three consecutive 1-second chunks a, b, c."""
    return [
        {"chunk_id": "a", "start_sample": 0, "end_sample": SAMPLE_RATE},
        {
            "chunk_id": "b",
            "start_sample": SAMPLE_RATE,
            "end_sample": 2 * SAMPLE_RATE,
        },
        {
            "chunk_id": "c",
            "start_sample": 2 * SAMPLE_RATE,
            "end_sample": 3 * SAMPLE_RATE,
        },
    ]


def test_extract_selects_chunks_starting_before_end_time():
    """Chunks that begin before the transcript end time are returned."""
    job = make_job()
    job._chunk_ledger = _one_second_ledger()
    # End at 1.5s -> sample 24000; chunks starting before it are a and b.
    assert job._extract_chunk_ids_for_time(1.5) == ["a", "b"]


def test_extract_zero_or_negative_end_time_returns_empty():
    """A missing/zero end time yields no chunk ids."""
    job = make_job()
    job._chunk_ledger = _one_second_ledger()
    assert not job._extract_chunk_ids_for_time(0)
    assert not job._extract_chunk_ids_for_time(-1)


def test_extract_prunes_records_purged_from_buffer():
    """Ledger records whose audio has been purged are dropped."""
    job = make_job()
    job._buffer_offset_samples = 2 * SAMPLE_RATE  # first two seconds purged
    job._chunk_ledger = _one_second_ledger()
    job._extract_chunk_ids_for_time(3.0)
    # Records whose audio is fully behind the buffer offset are dropped: 'a'
    # (ends at 16000 < 32000) goes; 'b' (ends at 32000) and 'c' stay.
    assert [r["chunk_id"] for r in job._chunk_ledger] == ["b", "c"]


def test_build_result_tags_final_and_in_progress_chunk_ids():
    """Each transcript is tagged with the chunk ids that produced it."""
    job = make_job()
    job._chunk_ledger = _one_second_ledger()
    final = TranscriptionSequence(text=["hi"], starts=[0.0], ends=[0.5])
    in_progress = TranscriptionSequence(
        text=["there"], starts=[1.0], ends=[1.5]
    )

    result = job._build_result(final, in_progress)

    # final ends at 0.5s -> sample 8000 -> only 'a'.
    assert result.final_chunk_ids == ["a"]
    # in_progress ends at 1.5s -> sample 24000 -> 'a' and 'b'.
    assert result.in_progress_chunk_ids == ["a", "b"]
    assert result.final is final
    assert result.in_progress is in_progress


def test_build_result_without_timestamps_yields_no_chunk_ids():
    """A transcript with no end timestamps can't be correlated to any chunk."""
    job = make_job()
    job._chunk_ledger = _one_second_ledger()
    # A sequence with no `ends` cannot be correlated to a time.
    final = TranscriptionSequence(text=["hi"], starts=None, ends=None)

    result = job._build_result(final, None)

    assert not result.final_chunk_ids
    assert not result.in_progress_chunk_ids


def _wav_chunk(seconds: float, chunk_id: str = "a") -> AudioChunkPayload:
    """Wrap `seconds` of silence as a mono 16-bit WAV chunk payload."""
    samples = np.zeros(int(SAMPLE_RATE * seconds), dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, samples, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return AudioChunkPayload(chunk_id=chunk_id, audio_bytes=buf.getvalue())


def test_build_result_has_no_audio_stats_before_any_audio_decoded():
    """The meter has not seen any samples yet, so audio_stats stays None."""
    job = make_job()
    job._chunk_ledger = _one_second_ledger()

    result = job._build_result(None, None)

    assert result.audio_stats is None


def test_process_batch_populates_audio_stats():
    """
    TranscriptionResult.audio_stats is populated after process_batch runs on
    real (minimally-synthesized) audio - the meter fed the same decoded
    samples _decode_audio already appends to the transcription buffer with.
    """
    job = make_job()
    log = MagicMock(spec=logging.Logger)
    whisper = MagicMock()
    whisper.transcribe.return_value = ([], None)

    result = job.process_batch(log, (whisper, MagicMock()), [_wav_chunk(0.5)])

    assert result.audio_stats is not None
    assert result.audio_stats.silence is True  # the chunk is silence
