"""
Unit tests for AudioMeter

Fixtures are synthesized with numpy rather than committed as binary WAV
files - a sine tone at a known dBFS, a full-scale square wave, silence, and
uniform noise are all cheap to generate on the fly and keep tolerances
parametrizable, per PLAN-B2.1-B2.3-audio-quality-telemetry.md §1.3.
"""

# pylint: disable=protected-access

import pickle
import time

import numpy as np
import pytest

from src.shared.utils.audio_meter import AudioLevelStats, AudioMeter, dbfs
from src.shared.utils.audio_meter.audio_meter import DB_FLOOR

SAMPLE_RATE = 16000


def sine_at_dbfs(dbfs: float, seconds: float = 1.0, freq: float = 440.0):
    """A sine tone at a known RMS dBFS level."""
    amplitude = 10 ** (dbfs / 20)
    t = np.arange(int(SAMPLE_RATE * seconds)) / SAMPLE_RATE
    # RMS of a sine of amplitude A is A / sqrt(2), so scale by sqrt(2) to
    # land the *RMS* (not the peak) at the requested dBFS.
    return (amplitude * np.sqrt(2) * np.sin(2 * np.pi * freq * t)).astype(
        np.float32
    )


def square_wave(
    seconds: float = 1.0, amplitude: float = 1.0, freq: float = 200.0
):
    """A full-scale square wave, useful for a near-100% clipping fixture."""
    t = np.arange(int(SAMPLE_RATE * seconds)) / SAMPLE_RATE
    return (amplitude * np.sign(np.sin(2 * np.pi * freq * t))).astype(
        np.float32
    )


def silence(seconds: float = 1.0):
    """An exact-zero array."""
    return np.zeros(int(SAMPLE_RATE * seconds), dtype=np.float32)


class TestDbfs:
    """
    Direct coverage of the public `dbfs()` helper (renamed from `_dbfs` in
    B2.2, so a second caller - the VAD-gated SNR calculation - could reuse it
    instead of a second `20 * log10(...)`). `TestKnownLevels` already
    exercises it indirectly through `rms_dbfs`/`peak_dbfs`; this covers the
    floor clamp directly instead of only inferring it from `silence`.
    """

    def test_full_scale_reads_as_zero_dbfs(self):
        """A linear amplitude of 1.0 is exactly 0 dBFS."""
        assert dbfs(1.0) == pytest.approx(0.0, abs=1e-9)

    def test_zero_is_clamped_at_the_floor(self):
        """A zero-valued RMS/peak never hits log10(0); it clamps at DB_FLOOR."""
        assert dbfs(0.0) == DB_FLOOR

    def test_negative_input_is_clamped_at_the_floor(self):
        """Defensive: a negative value (should not occur for RMS/peak) also clamps."""
        assert dbfs(-1.0) == DB_FLOOR

    def test_a_very_quiet_value_never_drops_below_the_floor(self):
        """An extremely small but positive amplitude still clamps at DB_FLOOR."""
        assert dbfs(1e-20) == DB_FLOOR


class TestKnownLevels:
    """Gate: known-dBFS sine tone in -> rms/peak dBFS within +/-0.5 dB."""

    def test_rms_dbfs_within_tolerance_of_known_level(self):
        """A -20 dBFS sine's rms_dbfs reads within +/-0.5 dB."""
        # Arrange
        meter = AudioMeter(sample_rate=SAMPLE_RATE)
        tone = sine_at_dbfs(-20.0)

        # Act
        meter.append(tone)
        stats = meter.snapshot()

        # Assert
        assert stats is not None
        assert stats.rms_dbfs == pytest.approx(-20.0, abs=0.5)

    def test_peak_dbfs_within_tolerance_of_known_level(self):
        """A full-scale sine's peak_dbfs reads within +/-0.5 dB of 0 dBFS."""
        # Arrange - a full-scale sine's peak sits at 0 dBFS.
        meter = AudioMeter(sample_rate=SAMPLE_RATE)
        t = np.arange(SAMPLE_RATE) / SAMPLE_RATE
        tone = np.sin(2 * np.pi * 440 * t).astype(np.float32)

        # Act
        meter.append(tone)
        stats = meter.snapshot()

        # Assert
        assert stats is not None
        assert stats.peak_dbfs == pytest.approx(0.0, abs=0.5)


class TestClipping:
    """Gate: full-scale square wave -> clipping_pct near 1.0; quiet sine -> near 0."""

    def test_full_scale_square_wave_clips_almost_entirely(self):
        """A full-scale square wave clips on almost every sample."""
        # Arrange
        meter = AudioMeter(sample_rate=SAMPLE_RATE)

        # Act
        meter.append(square_wave())
        stats = meter.snapshot()

        # Assert
        assert stats is not None
        assert stats.clipping_pct > 0.99

    def test_quiet_sine_does_not_clip(self):
        """A -20 dBFS sine has essentially no samples at full scale."""
        # Arrange
        meter = AudioMeter(sample_rate=SAMPLE_RATE)

        # Act
        meter.append(sine_at_dbfs(-20.0))
        stats = meter.snapshot()

        # Assert
        assert stats is not None
        assert stats.clipping_pct == pytest.approx(0.0, abs=1e-6)


class TestSilence:
    """Gate: a zero array reads as silence; a normal tone does not."""

    def test_zero_array_is_silence(self):
        """An all-zero window reads as silence."""
        # Arrange
        meter = AudioMeter(sample_rate=SAMPLE_RATE)

        # Act
        meter.append(silence())
        stats = meter.snapshot()

        # Assert
        assert stats is not None
        assert stats.silence is True

    def test_audible_tone_is_not_silence(self):
        """A -20 dBFS sine, well above the default threshold, is not silence."""
        # Arrange
        meter = AudioMeter(sample_rate=SAMPLE_RATE, silence_threshold=0.01)

        # Act
        meter.append(sine_at_dbfs(-20.0))
        stats = meter.snapshot()

        # Assert
        assert stats is not None
        assert stats.silence is False


class TestAbsence:
    """Gate: a window with zero samples appended returns None, not a value."""

    def test_snapshot_is_none_before_any_samples(self):
        """A meter that has never seen a sample returns None, not a value."""
        # Arrange
        meter = AudioMeter(sample_rate=SAMPLE_RATE)

        # Act / Assert
        assert meter.snapshot() is None

    def test_appending_an_empty_array_still_reads_as_no_data(self):
        """Appending zero samples does not count as receiving data."""
        # Arrange
        meter = AudioMeter(sample_rate=SAMPLE_RATE)

        # Act
        meter.append(np.array([], dtype=np.float32))

        # Assert
        assert meter.snapshot() is None


class TestNoiseFloor:
    """Noise floor over sub-windows, and the startup-transient shortcut."""

    def test_noise_floor_falls_back_to_whole_window_rms_when_too_little_data(
        self,
    ):
        """Fewer than two sub-windows' worth of data -> falls back to rms_dbfs."""
        # Arrange - one sub_window_sec of data is not enough to sub-divide.
        meter = AudioMeter(
            sample_rate=SAMPLE_RATE, sub_window_sec=1.0, window_sec=10.0
        )
        tone = sine_at_dbfs(-20.0, seconds=0.5)

        # Act
        meter.append(tone)
        stats = meter.snapshot()

        # Assert
        assert stats is not None
        assert stats.noise_floor_dbfs == pytest.approx(stats.rms_dbfs, abs=0.01)

    def test_noise_floor_is_below_a_loud_windows_rms(self):
        """The 10th percentile across sub-windows tracks a quiet interval."""
        # Arrange - one quiet second among several loud ones: the 10th
        # percentile across sub-windows should reflect the quiet one, well
        # under the whole window's own average RMS.
        meter = AudioMeter(
            sample_rate=SAMPLE_RATE, sub_window_sec=1.0, window_sec=10.0
        )
        for _ in range(9):
            meter.append(sine_at_dbfs(-10.0, seconds=1.0))
        meter.append(sine_at_dbfs(-60.0, seconds=1.0))

        # Act
        stats = meter.snapshot()

        # Assert - the whole window's RMS is dominated by the nine loud
        # seconds (~-10.5 dBFS), but the 10th percentile across sub-windows
        # pulls well below that towards the one quiet second.
        assert stats is not None
        assert stats.noise_floor_dbfs < stats.rms_dbfs - 4


class TestRollingWindowPurge:
    """
    Gate: the ring never exceeds its configured size and older samples are
    evicted, not rejected - the exact gotcha NPCircularBuffer's reject-on-
    overflow behavior creates if used unmodified (§A.1).
    """

    def test_buffer_never_exceeds_configured_size(self):
        """Feeding more than window_sec worth of audio never grows the ring."""
        # Arrange - a short window, several batches that together exceed it.
        meter = AudioMeter(sample_rate=SAMPLE_RATE, window_sec=1.0)

        # Act - append 3 seconds' worth into a 1-second window.
        for _ in range(3):
            meter.append(np.ones(SAMPLE_RATE, dtype=np.float32) * 0.5)

        # Assert - internal buffer length, not samples fed, is what must stay
        # bounded.
        assert len(meter._buffer) == SAMPLE_RATE

    def test_oldest_samples_are_evicted_not_rejected(self):
        """New audio past capacity slides the window instead of being dropped."""
        # Arrange - a window that can hold exactly one second.
        meter = AudioMeter(sample_rate=SAMPLE_RATE, window_sec=1.0)
        quiet = np.zeros(SAMPLE_RATE, dtype=np.float32)
        loud = np.ones(SAMPLE_RATE, dtype=np.float32) * 0.5

        # Act - fill with quiet audio, then push a full window of loud audio.
        # A reject-on-overflow buffer would keep the quiet audio (rejecting
        # the loud batch instead of sliding), and the window would still
        # read as silent.
        meter.append(quiet)
        meter.append(loud)
        stats = meter.snapshot()

        # Assert - the window now reflects only the newest (loud) audio.
        assert stats is not None
        assert stats.silence is False
        assert len(meter._buffer) == SAMPLE_RATE

    def test_partial_overlap_purge_keeps_only_the_newest_tail(self):
        """A batch that only partially overflows purges just enough, not all."""
        # Arrange
        meter = AudioMeter(sample_rate=SAMPLE_RATE, window_sec=1.0)
        first_half = np.zeros(SAMPLE_RATE // 2, dtype=np.float32)
        second_half = np.ones(SAMPLE_RATE // 2, dtype=np.float32) * 0.9
        third_quarter = np.ones(SAMPLE_RATE // 2, dtype=np.float32) * 0.9

        # Act - fills the window, then pushes half a window more, which must
        # purge exactly the oldest quarter rather than rejecting anything.
        meter.append(first_half)
        meter.append(second_half)
        meter.append(third_quarter)

        # Assert
        assert len(meter._buffer) == SAMPLE_RATE
        window = np.asarray(meter._buffer.get())
        # No sample from the original all-zero first half should remain.
        assert np.all(window != 0)


class TestCpuBudget:
    """
    Provisional budget, not independently validated - see
    PLAN-B2.1-B2.3-audio-quality-telemetry.md §4 open question 1.
    """

    def test_append_and_snapshot_complete_within_budget(self):
        """append()+snapshot() over a ~1s batch average under 2ms."""
        # Arrange
        meter = AudioMeter(sample_rate=SAMPLE_RATE)
        batch = sine_at_dbfs(-20.0, seconds=1.0)
        iterations = 100

        # Warm up (first call may pay import/allocation costs).
        meter.append(batch)
        meter.snapshot()

        # Act
        start = time.perf_counter()
        for _ in range(iterations):
            meter.append(batch)
            meter.snapshot()
        elapsed = time.perf_counter() - start
        mean_sec = elapsed / iterations

        # Assert
        assert mean_sec < 0.002, (
            f"AudioMeter.append()+.snapshot() averaged {mean_sec * 1000:.3f}ms "
            "per ~1s batch, over the provisional 2ms budget"
        )


def test_audio_level_stats_is_picklable():
    """
    AudioLevelStats crosses a multiprocess (spawn) queue boundary on
    TranscriptionResult, so it must be picklable - which a plain frozen
    dataclass of Python floats/bools is, as long as nothing numpy leaks in.
    """
    stats = AudioLevelStats(
        rms_dbfs=-20.0,
        peak_dbfs=-10.0,
        clipping_pct=0.0,
        silence=False,
        noise_floor_dbfs=-40.0,
    )

    restored = pickle.loads(pickle.dumps(stats))

    assert restored == stats
    assert isinstance(restored.rms_dbfs, float)
    assert isinstance(restored.silence, bool)
