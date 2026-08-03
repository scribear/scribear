"""
Unit tests for WhisperStreamingProviderJob chunk-id ledger/latency
correlation, its per-batch VAD statistics (B2.2), and the audio stage graph it
reports (asr_input and vad). Exercises pure bookkeeping (which chunk ids a
transcript end time maps to, ledger pruning, VAD-stats accumulation, cumulative
per-stage seconds) mostly without invoking the real Whisper model.
"""

# pylint: disable=protected-access

import io
import logging
from unittest.mock import MagicMock

import numpy as np
import pytest
import soundfile as sf

from src.transcription_provider_interface import (
    STAGE_ASR_INPUT,
    STAGE_INGRESS,
    STAGE_VAD,
    AudioChunkPayload,
    AudioStageReading,
    TranscriptionJobCounter,
    TranscriptionResult,
    TranscriptionSequence,
)
from src.transcription_providers.whisper_streaming_provider.whisper_streaming_config import (
    WhisperStreamingProviderConfig,
)
from src.transcription_providers.whisper_streaming_provider.whisper_streaming_job import (
    SAMPLE_RATE,
    WhisperStreamingProviderJob,
)


def make_job(vad_detector: bool = False) -> WhisperStreamingProviderJob:
    """A job with a minimal valid config (VAD disabled by default)."""
    config = WhisperStreamingProviderConfig(
        whisper_context_tag="w",
        silero_context_tag="s",
        job_period_ms=5000,
        max_buffer_len_sec=30,
        local_agree_dim=2,
        vad_detector=vad_detector,
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


def _stage(
    result: TranscriptionResult, stage_id: str
) -> AudioStageReading | None:
    """The reading for `stage_id`, or None when this result reported none."""
    return next((s for s in result.audio_stages if s.stage == stage_id), None)


def test_asr_input_stage_reports_no_levels_before_any_audio_decoded():
    """
    The meter has no window yet, so the stage carries levels=None - "no data
    yet", which must never be published as a measured silence. The stage is
    reported all the same: "how much audio reached the ASR buffer" has an
    answer (none) before any level reading exists, and it is the answer that
    distinguishes a source fault from a pipeline fault.
    """
    job = make_job()
    job._chunk_ledger = _one_second_ledger()

    result = job._build_result(None, None)

    asr_input = _stage(result, STAGE_ASR_INPUT)
    assert asr_input is not None
    assert asr_input.levels is None
    assert asr_input.audio_seconds == 0.0
    # Declares what fed it, never its own depth - the publisher derives that.
    assert asr_input.inputs == (STAGE_INGRESS,)
    assert asr_input.vad is None


def test_asr_input_stage_reports_levels_once_audio_is_decoded():
    """
    The stage's levels come from the meter fed the same decoded samples
    _decode_audio appends to the transcription buffer, so a batch of real
    (minimally-synthesized) audio produces a reading rather than a hole.
    """
    job = make_job()
    log = MagicMock(spec=logging.Logger)
    whisper = MagicMock()
    whisper.transcribe.return_value = ([], None)

    result = job.process_batch(log, (whisper, MagicMock()), [_wav_chunk(0.5)])

    asr_input = _stage(result, STAGE_ASR_INPUT)
    assert asr_input is not None
    assert asr_input.levels is not None
    assert asr_input.levels.silence is True  # the chunk is silence
    assert asr_input.audio_seconds == pytest.approx(0.5)


def test_asr_input_seconds_accumulate_across_batches_and_survive_a_drain():
    """
    The stage total is cumulative for the life of the session, which is the
    only reason an ingress -> asr_input comparison means anything: the two ends
    are sampled at different instants and only agree as running totals.

    drain_counters() is deliberately called in between. AUDIO_SECONDS_DECODED
    carries the same seconds but resets on every drain (per-execution deltas,
    by contract), so a stage total read back from the counters would report
    0.25 here instead of 0.75.
    """
    job = make_job()
    log = MagicMock(spec=logging.Logger)
    whisper = MagicMock()
    whisper.transcribe.return_value = ([], None)

    job.process_batch(log, (whisper, MagicMock()), [_wav_chunk(0.5, "a")])
    drained = job.drain_counters()
    result = job.process_batch(
        log, (whisper, MagicMock()), [_wav_chunk(0.25, "b")]
    )

    assert drained[TranscriptionJobCounter.AUDIO_SECONDS_DECODED] == 0.5
    asr_input = _stage(result, STAGE_ASR_INPUT)
    assert asr_input is not None
    assert asr_input.audio_seconds == pytest.approx(0.75)


class TestVadStats:
    """
    VAD statistics (B2.2), accumulated from the same ranges
    `_detect_speech_ranges` already computes to decide what to hand
    Whisper - no separate detection logic, just reduction over `ranges`.
    """

    def test_vad_off_every_field_is_none_except_enabled(self):
        """
        VAD off: even a real-looking full-buffer range is not a
        measurement, so every field but vad_enabled reports None.
        """
        job = make_job(vad_detector=False)
        buffer_samples = np.zeros(SAMPLE_RATE, dtype=np.float32)

        stats = job._compute_vad_stats([(0, SAMPLE_RATE)], buffer_samples)

        assert stats.vad_enabled is False
        assert stats.speech_active_ratio is None
        assert stats.segment_count is None
        assert stats.mean_segment_duration_sec is None
        assert stats.speech_to_pause_ratio is None
        assert stats.snr_db is None

    def test_vad_on_speech_found_computes_known_values(self):
        """Two known ranges over a 1s buffer produce exact expected stats."""
        job = make_job(vad_detector=True)
        buffer_samples = np.zeros(SAMPLE_RATE, dtype=np.float32)
        # Two 0.25s speech ranges (quarter 1, quarter 3) - 0.5s speech total
        # out of a 1s buffer.
        ranges = [
            (0, SAMPLE_RATE // 4),
            (SAMPLE_RATE // 2, 3 * SAMPLE_RATE // 4),
        ]

        stats = job._compute_vad_stats(ranges, buffer_samples)

        assert stats.vad_enabled is True
        assert stats.speech_active_ratio == pytest.approx(0.5)
        assert stats.segment_count == 2
        assert stats.mean_segment_duration_sec == pytest.approx(0.25)
        # 0.5 / (1 - 0.5) == 1.0
        assert stats.speech_to_pause_ratio == pytest.approx(1.0)

    def test_vad_on_no_speech_found_is_a_real_zero_reading(self):
        """
        VAD ran and found nothing: speech_active_ratio/segment_count/
        speech_to_pause_ratio are real zeros, but mean_segment_duration_sec
        and snr_db are undefined (None), not zero.
        """
        job = make_job(vad_detector=True)
        buffer_samples = np.zeros(SAMPLE_RATE, dtype=np.float32)

        stats = job._compute_vad_stats([], buffer_samples)

        assert stats.vad_enabled is True
        assert stats.speech_active_ratio == 0.0
        assert stats.segment_count == 0
        assert stats.mean_segment_duration_sec is None
        assert stats.speech_to_pause_ratio == 0.0
        assert stats.snr_db is None

    def test_vad_on_all_speech_guards_the_divide_by_zero(self):
        """A buffer that's 100% speech-active has no pause to divide by."""
        job = make_job(vad_detector=True)
        buffer_samples = np.zeros(SAMPLE_RATE, dtype=np.float32)

        stats = job._compute_vad_stats([(0, SAMPLE_RATE)], buffer_samples)

        assert stats.speech_active_ratio == pytest.approx(1.0)
        assert stats.speech_to_pause_ratio is None
        # No out-of-range samples to compare against - also None.
        assert stats.snr_db is None

    def test_empty_buffer_leaves_vad_stats_none_not_all_none_fields(self):
        """
        _transcribe_audio's early return (buffer currently empty) means no
        VAD ran at all this call - the whole reading is absent, not a
        VadStats populated with Nones.
        """
        job = make_job(vad_detector=True)
        log = MagicMock(spec=logging.Logger)

        segments = job._transcribe_audio(MagicMock(), MagicMock(), log)

        assert not segments
        assert job._vad_stats is None

    def test_snr_is_positive_for_a_loud_in_range_signal_over_quiet_noise(self):
        """
        A buffer with a loud tone inside `ranges` and quiet noise outside it
        reads as a clearly positive SNR - not an exact value, since SNR from
        synthetic signals is approximate, but well above zero.
        """
        job = make_job(vad_detector=True)
        rng = np.random.default_rng(0)
        t = np.arange(SAMPLE_RATE // 2) / SAMPLE_RATE
        loud_tone = (0.9 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        quiet_noise = rng.uniform(-0.001, 0.001, SAMPLE_RATE // 2).astype(
            np.float32
        )
        buffer_samples = np.concatenate([loud_tone, quiet_noise])
        ranges = [(0, len(loud_tone))]

        snr_db = job._compute_snr_db(ranges, buffer_samples)

        assert snr_db is not None
        assert 20.0 < snr_db < 100.0

    def test_process_batch_populates_vad_stats_when_vad_is_on(self):
        """
        End to end: process_batch on VAD-enabled audio surfaces the detector
        reading on the vad stage of the result, mirroring how the asr_input
        stage carries the meter's.
        """
        job = make_job(vad_detector=True)
        log = MagicMock(spec=logging.Logger)
        whisper = MagicMock()
        whisper.transcribe.return_value = ([], None)
        vad_context = MagicMock()
        vad_context.create_stream.return_value.detect_speech_ranges.return_value = [
            (0, SAMPLE_RATE // 4)
        ]

        result = job.process_batch(
            log, (whisper, vad_context), [_wav_chunk(0.5)]
        )

        vad_stage = _stage(result, STAGE_VAD)
        assert vad_stage is not None
        assert vad_stage.inputs == (STAGE_ASR_INPUT,)
        # A detector measures speech, not levels - a levels reading here would
        # be a second, unattributed copy of the asr_input one.
        assert vad_stage.levels is None
        assert vad_stage.vad is not None
        assert vad_stage.vad.vad_enabled is True
        assert vad_stage.vad.segment_count == 1


class TestAudioStageFunnel:
    """
    The per-stage seconds totals, which are what turn the stage graph into an
    answer to "where did the audio go" rather than two unrelated numbers.
    """

    @staticmethod
    def _vad_context(*range_lists):
        """A VAD stand-in returning `range_lists[n]` on the nth detection."""
        vad_context = MagicMock()
        stream = vad_context.create_stream.return_value
        stream.detect_speech_ranges.side_effect = list(range_lists)
        return vad_context

    @staticmethod
    def _whisper():
        """A Whisper stand-in that transcribes nothing, so nothing is purged."""
        whisper = MagicMock()
        whisper.transcribe.return_value = ([], None)
        return whisper

    def test_vad_passes_on_less_audio_than_was_decoded(self):
        """
        The gated case is the whole point of the graph: 0.5s decoded, 0.25s of
        it speech, so the vad stage must report strictly less than asr_input.
        Equal totals here would mean the detector's own gating is invisible on
        the dashboard - "a detector eating the room" is the failure this edge
        exists to catch.
        """
        # Arrange
        job = make_job(vad_detector=True)
        log = MagicMock(spec=logging.Logger)
        vad_context = self._vad_context([(0, SAMPLE_RATE // 4)])

        # Act
        result = job.process_batch(
            log, (self._whisper(), vad_context), [_wav_chunk(0.5)]
        )

        # Assert
        asr_input = _stage(result, STAGE_ASR_INPUT)
        vad_stage = _stage(result, STAGE_VAD)
        assert asr_input is not None and vad_stage is not None
        assert asr_input.audio_seconds == pytest.approx(0.5)
        assert vad_stage.audio_seconds == pytest.approx(0.25)
        assert vad_stage.audio_seconds < asr_input.audio_seconds

    def test_speech_seconds_are_not_recounted_when_the_buffer_is_redetected(
        self,
    ):
        """
        The buffer is re-detected whole every job period, so successive passes
        report the same early speech again. Summing each pass would make the
        vad stage claim more audio passed on than was ever decoded - the one
        thing a cumulative total may never do, and the reason the accumulator
        is watermarked on absolute stream position.

        Second pass sees the first 0.25s again plus a new 0.25s range, so the
        total is 0.5s, not 0.75s.
        """
        # Arrange
        job = make_job(vad_detector=True)
        log = MagicMock(spec=logging.Logger)
        quarter = SAMPLE_RATE // 4
        vad_context = self._vad_context(
            [(0, quarter)], [(0, quarter), (2 * quarter, 3 * quarter)]
        )
        whisper = self._whisper()

        # Act
        job.process_batch(log, (whisper, vad_context), [_wav_chunk(0.5, "a")])
        result = job.process_batch(
            log, (whisper, vad_context), [_wav_chunk(0.5, "b")]
        )

        # Assert
        asr_input = _stage(result, STAGE_ASR_INPUT)
        vad_stage = _stage(result, STAGE_VAD)
        assert asr_input is not None and vad_stage is not None
        assert asr_input.audio_seconds == pytest.approx(1.0)
        assert vad_stage.audio_seconds == pytest.approx(0.5)
        assert vad_stage.audio_seconds <= asr_input.audio_seconds

    def test_vad_stage_with_the_detector_off_reports_the_audio_it_passed_on(
        self,
    ):
        """
        VAD off: no speech was measured (every VadStats field but vad_enabled
        is None), yet the whole buffer really is handed to Whisper, so the
        seconds past this point are the seconds decoded. Reporting None there
        instead would blank the funnel for every deployment that runs without a
        detector; reporting less would invent gating loss that never happened.
        """
        # Arrange
        job = make_job(vad_detector=False)
        log = MagicMock(spec=logging.Logger)

        # Act
        result = job.process_batch(
            log, (self._whisper(), MagicMock()), [_wav_chunk(0.5)]
        )

        # Assert
        asr_input = _stage(result, STAGE_ASR_INPUT)
        vad_stage = _stage(result, STAGE_VAD)
        assert asr_input is not None and vad_stage is not None
        assert vad_stage.vad is not None
        assert vad_stage.vad.vad_enabled is False
        assert vad_stage.audio_seconds == pytest.approx(asr_input.audio_seconds)

    def test_vad_stage_is_omitted_when_no_detection_pass_ran(self):
        """
        _vad_stats is None only when no VAD pass happened at all (empty
        buffer), so there is no detector reading to publish. Emitting the stage
        anyway - vad None, levels None, seconds only - would let a reader
        compare the asr_input -> vad edge and charge the whole difference to
        gating that never took place. An incomplete graph for one snapshot is
        the honest form of that absence.
        """
        # Arrange
        job = make_job(vad_detector=True)

        # Act
        result = job._build_result(None, None)

        # Assert
        assert _stage(result, STAGE_VAD) is None
        assert _stage(result, STAGE_ASR_INPUT) is not None
