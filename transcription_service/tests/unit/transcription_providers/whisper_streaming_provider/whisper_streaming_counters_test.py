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
    STAGE_ASR_INPUT,
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


def make_word(text: str, start: float = 0.0, end: float = 0.5):
    """A stand-in for a faster-whisper Word: only the fields the job reads."""
    word = MagicMock()
    word.word = text
    word.start = start
    word.end = end
    return word


def make_part(
    words=(),
    avg_logprob: float = -0.1,
    no_speech_prob: float = 0.1,
    compression_ratio: float = 1.0,
    temperature: float = 0.0,
):
    """
    A stand-in for a faster-whisper Segment carrying only the fields the job
    reads, with quality-signal defaults that never trip a guard.
    """
    part = MagicMock()
    part.words = list(words)
    part.avg_logprob = avg_logprob
    part.no_speech_prob = no_speech_prob
    part.compression_ratio = compression_ratio
    part.temperature = temperature
    return part


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
    # The job VADs through a per-session stream it creates from the shared
    # context, so the stream is what has to be stubbed.
    vad = MagicMock()
    vad.create_stream.return_value.detect_speech_ranges.return_value = []

    job.process_batch(log, (MagicMock(), vad), [chunk(0.5)])

    assert job.drain_counters()[TranscriptionJobCounter.VAD_NO_SPEECH] == 1


def test_survives_a_batch_the_buffer_has_no_room_for(log, contexts):
    """A batch bigger than the buffer drops its tail; it does not end the job.

    The buffer is sized at twice max_buffer_len_sec, so a chunk past that
    overruns it in one call. That used to raise, and any job exception
    deregisters the job - so a service stall that made one batch too large
    disconnected every saturated session and blamed the client for it. The
    overrun is counted and survivable instead.
    """
    job = make_job(max_buffer_len_sec=1)

    # 5s into a buffer that holds 2s: 3s has nowhere to go.
    job.process_batch(log, contexts, [chunk(5)])

    counters = job.drain_counters()
    assert counters[TranscriptionJobCounter.AUDIO_DROPPED_BUFFER_FULL] == 1
    assert counters[
        TranscriptionJobCounter.AUDIO_DROPPED_BUFFER_FULL_SECONDS
    ] == pytest.approx(3.0)

    # And the job is still usable afterwards, which is the whole point.
    job.process_batch(log, contexts, [chunk(0.5)])


def test_dropped_audio_is_not_counted_as_decoded(log, contexts):
    """Only samples the buffer kept count as decoded.

    `_total_decoded_samples` is the absolute stream position word timestamps
    and ledger spans resolve against, and `_decoded_audio_seconds` is the
    asr_input stage reading whose gap below ingress is *defined* as what the
    pipeline lost. Charging either for audio that was dropped would desync
    timestamps permanently from the first drop onwards, and would hide the
    loss from the stage graph at the same time.
    """
    job = make_job(max_buffer_len_sec=1)

    # 5s offered, 2s of room: 2s decoded, 3s dropped.
    result = job.process_batch(log, contexts, [chunk(5)])

    counters = job.drain_counters()
    assert counters[
        TranscriptionJobCounter.AUDIO_SECONDS_DECODED
    ] == pytest.approx(2.0)

    asr_input = next(
        stage for stage in result.audio_stages if stage.stage == STAGE_ASR_INPUT
    )
    assert asr_input.audio_seconds == pytest.approx(2.0)


def test_drain_resets_between_executions(log, contexts):
    """Counters are per-execution deltas, never running totals."""
    job = make_job()

    job.process_batch(log, contexts, [chunk(0.5)])
    job.drain_counters()

    assert not job.drain_counters()


def test_counts_compression_ratio_guard_fired_above_threshold(log, contexts):
    """A segment's compression_ratio over the configured threshold is counted.

    High compression ratio means the text is repetitive - one of Whisper's
    own hallucination-risk signals.
    """
    job = make_job()
    contexts[0].transcribe.return_value = (
        [make_part(compression_ratio=3.0)],
        None,
    )

    job.process_batch(log, contexts, [chunk(0.5)])

    counters = job.drain_counters()
    assert counters[TranscriptionJobCounter.COMPRESSION_RATIO_GUARD_FIRED] == 1


def test_compression_ratio_guard_does_not_fire_below_threshold(log, contexts):
    """A segment's compression_ratio at or under the threshold is not counted."""
    job = make_job()
    contexts[0].transcribe.return_value = (
        [make_part(compression_ratio=1.5)],
        None,
    )

    job.process_batch(log, contexts, [chunk(0.5)])

    counters = job.drain_counters()
    assert TranscriptionJobCounter.COMPRESSION_RATIO_GUARD_FIRED not in counters


def test_counts_avg_logprob_guard_fired_below_threshold(log, contexts):
    """A segment's avg_logprob under the configured threshold is counted.

    A low average log-probability means Whisper itself was not confident in
    what it decoded.
    """
    job = make_job()
    contexts[0].transcribe.return_value = ([make_part(avg_logprob=-2.0)], None)

    job.process_batch(log, contexts, [chunk(0.5)])

    counters = job.drain_counters()
    assert counters[TranscriptionJobCounter.AVG_LOGPROB_GUARD_FIRED] == 1


def test_avg_logprob_guard_does_not_fire_above_threshold(log, contexts):
    """A segment's avg_logprob at or over the threshold is not counted."""
    job = make_job()
    contexts[0].transcribe.return_value = ([make_part(avg_logprob=-0.5)], None)

    job.process_batch(log, contexts, [chunk(0.5)])

    counters = job.drain_counters()
    assert TranscriptionJobCounter.AVG_LOGPROB_GUARD_FIRED not in counters


def test_counts_no_speech_prob_guard_fired_above_threshold(log, contexts):
    """A segment's no_speech_prob over the configured threshold is counted.

    A high no-speech probability flags audio that likely produced text
    anyway - silence or noise misread as speech.
    """
    job = make_job()
    contexts[0].transcribe.return_value = (
        [make_part(no_speech_prob=0.9)],
        None,
    )

    job.process_batch(log, contexts, [chunk(0.5)])

    counters = job.drain_counters()
    assert counters[TranscriptionJobCounter.NO_SPEECH_PROB_GUARD_FIRED] == 1


def test_no_speech_prob_guard_does_not_fire_below_threshold(log, contexts):
    """A segment's no_speech_prob at or under the threshold is not counted."""
    job = make_job()
    contexts[0].transcribe.return_value = (
        [make_part(no_speech_prob=0.2)],
        None,
    )

    job.process_batch(log, contexts, [chunk(0.5)])

    counters = job.drain_counters()
    assert TranscriptionJobCounter.NO_SPEECH_PROB_GUARD_FIRED not in counters


def test_counts_temperature_fallback_when_temperature_is_positive(
    log, contexts
):
    """A segment decoded above temperature 0 is counted.

    faster-whisper only retries at a higher sampling temperature when its own
    quality checks rejected the greedy result - this counter surfaces that
    fallback, it does not detect anything new.
    """
    job = make_job()
    contexts[0].transcribe.return_value = ([make_part(temperature=0.4)], None)

    job.process_batch(log, contexts, [chunk(0.5)])

    counters = job.drain_counters()
    assert counters[TranscriptionJobCounter.TEMPERATURE_FALLBACK] == 1


def test_temperature_fallback_does_not_fire_at_zero(log, contexts):
    """Greedy decoding (temperature 0) is not counted as a fallback."""
    job = make_job()
    contexts[0].transcribe.return_value = ([make_part(temperature=0.0)], None)

    job.process_batch(log, contexts, [chunk(0.5)])

    counters = job.drain_counters()
    assert TranscriptionJobCounter.TEMPERATURE_FALLBACK not in counters


def test_repeated_segment_detector_is_wired_into_finalization(log):
    """
    A finalized segment that near-verbatim repeats the previously finalized
    one is counted, via the same self._last_finalized assignment sites the
    detector is wired against.

    local_agree_dim=1 commits a segment as soon as it appears once, and a
    sentence-ending word finalizes it immediately - both used here purely to
    keep this a single-segment-per-batch test, not to exercise LocalAgree
    itself (that has its own test suite).
    """
    job = make_job(local_agree_dim=1, max_buffer_len_sec=5)
    whisper = MagicMock()
    vad = MagicMock()

    repeated_text = "the quick brown fox jumps over the lazy dog."
    part = make_part(words=[make_word(repeated_text, start=0.0, end=0.5)])
    whisper.transcribe.return_value = ([part], None)

    # First finalization: nothing to compare against yet, so no hit.
    job.process_batch(log, (whisper, vad), [chunk(0.5)])
    assert TranscriptionJobCounter.REPEATED_SEGMENT_DETECTED not in (
        job.drain_counters()
    )

    # Second finalization repeats the same text almost verbatim.
    job.process_batch(log, (whisper, vad), [chunk(0.5)])
    counters = job.drain_counters()
    assert counters[TranscriptionJobCounter.REPEATED_SEGMENT_DETECTED] == 1
