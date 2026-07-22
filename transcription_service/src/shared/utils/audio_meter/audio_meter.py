"""
Defines AudioMeter, a rolling-window audio-level meter (B2.1)
"""

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

from src.shared.utils.np_circular_buffer import NPCircularBuffer

# Floor applied to dB computations so a silent/zero buffer never hits
# log10(0). -120 dBFS is well below anything a 16-bit source could represent
# (roughly -96 dBFS full scale), so it reads as "silent" without being -inf.
DB_FLOOR = -120.0

# Samples within this of full scale (1.0) count as clipped. A hard `== 1.0`
# check would miss real clipping: a source that clipped in its original
# integer domain and was then decoded to float32 rarely lands on exactly
# 1.0 after the conversion's rounding, so a small tolerance is what actually
# catches it.
CLIP_EPSILON = 1e-4


@dataclass(frozen=True)
class AudioLevelStats:
    """
    Point-in-time audio-level readout over an `AudioMeter`'s current window

    All fields are plain Python floats/bools (never numpy scalar types) so
    this dataclass stays picklable across the worker->main-process queue
    boundary it crosses on `TranscriptionResult`.
    """

    rms_dbfs: float
    peak_dbfs: float
    #: Fraction (0..1) of samples within CLIP_EPSILON of full scale.
    clipping_pct: float
    #: True when rms_dbfs is at or below the configured silence floor.
    silence: bool
    #: Low-percentile RMS across sub-windows of the current buffer - an
    #: estimate of the ambient noise floor, distinct from momentary silence.
    noise_floor_dbfs: float


def _dbfs(value: float) -> float:
    """
    Converts a linear amplitude/RMS value to dBFS, clamped at DB_FLOOR

    Args:
        value   - Linear amplitude in [0, 1], e.g. an RMS or peak sample value

    Returns:
        20 * log10(value), or DB_FLOOR when value is at or below zero
    """
    if value <= 0:
        return DB_FLOOR
    return max(DB_FLOOR, float(20 * np.log10(value)))


class AudioMeter:
    """
    Computes RMS/peak/clipping/silence/noise-floor stats over a fixed
    wall-clock rolling window of decoded audio, independent of any
    transcription buffer.

    Reuses `NPCircularBuffer` as the underlying ring, but that primitive does
    **not** auto-evict on overflow - `.append()` fills whatever space remains
    and returns the samples that did not fit, rejecting overflow rather than
    sliding the window. A true rolling window instead purges the oldest
    samples itself before appending whenever the incoming batch would not
    otherwise fit, so the window always holds the most recent `window_sec`
    seconds of audio rather than rejecting everything past the first fill.
    """

    def __init__(
        self,
        sample_rate: int,
        window_sec: float = 10.0,
        silence_threshold: float = 0.01,
        sub_window_sec: float = 1.0,
    ):
        """
        Args:
            sample_rate         - Samples per second of the audio fed in
            window_sec           - Length of the rolling window, in seconds
            silence_threshold    - Linear RMS threshold below which the
                                     window reads as silence. Shared with
                                     `RMSSilenceDetection`/`whisper.transcribe`'s
                                     `hallucination_silence_threshold` so
                                     silence classification does not quietly
                                     diverge from what config already tunes.
            sub_window_sec        - Size of the sub-windows the noise floor
                                     is computed over
        """
        self._sample_rate = sample_rate
        self._silence_threshold = silence_threshold
        self._sub_window_samples = max(1, int(sample_rate * sub_window_sec))
        self._max_size = int(sample_rate * window_sec)
        self._buffer = NPCircularBuffer(self._max_size, dtype=np.float32)
        self._has_data = False

    def append(self, samples: npt.NDArray) -> None:
        """
        Feeds newly decoded samples into the rolling window

        Purges the oldest samples first when the incoming batch would not
        otherwise fit, so the window rolls (oldest samples drop off) rather
        than rejecting the overflow the way a bare `NPCircularBuffer` would.

        Args:
            samples - Newly decoded float32 samples in [-1.0, 1.0)
        """
        if len(samples) == 0:
            return

        # Never need to hold onto more than the window can ever contain.
        if len(samples) > self._max_size:
            samples = samples[-self._max_size :]

        space_available = self._max_size - len(self._buffer)
        if len(samples) > space_available:
            self._buffer.purge(len(samples) - space_available)
        self._buffer.append(samples)
        self._has_data = True

    def snapshot(self) -> AudioLevelStats | None:
        """
        Computes a point-in-time readout over the current window

        Returns:
            None if the window has received no samples yet - "no data yet" is
            a legitimate absence, not silence, so it is not reported as one.
            Otherwise an AudioLevelStats over whatever is currently buffered.
        """
        if not self._has_data:
            return None

        window = np.asarray(self._buffer.get())
        if window.size == 0:
            return None

        rms = float(np.sqrt(np.mean(np.square(window, dtype=np.float64))))
        peak = float(np.max(np.abs(window)))

        clipping_pct = float(np.mean(np.abs(window) >= 1.0 - CLIP_EPSILON))

        rms_dbfs = _dbfs(rms)
        silence = rms_dbfs <= _dbfs(self._silence_threshold)

        return AudioLevelStats(
            rms_dbfs=rms_dbfs,
            peak_dbfs=_dbfs(peak),
            clipping_pct=clipping_pct,
            silence=bool(silence),
            noise_floor_dbfs=self._noise_floor_dbfs(window, rms_dbfs),
        )

    def _noise_floor_dbfs(self, window: npt.NDArray, rms_dbfs: float) -> float:
        """
        10th-percentile RMS (in dB) across sub-windows of the current buffer

        Args:
            window      - The full current window, as returned by the ring
            rms_dbfs    - The whole window's own RMS, used as a startup-
                            transient approximation

        Returns:
            The single window's rms_dbfs if fewer than two sub-windows'
            worth of data are buffered yet (not a bug - just not enough data
            to usefully sub-divide), otherwise the 10th percentile of each
            sub-window's RMS in dB.
        """
        num_sub_windows = window.size // self._sub_window_samples
        if num_sub_windows < 2:
            return rms_dbfs

        usable = window[: num_sub_windows * self._sub_window_samples]
        sub_windows = usable.reshape(num_sub_windows, self._sub_window_samples)
        sub_window_rms = np.sqrt(
            np.mean(np.square(sub_windows, dtype=np.float64), axis=1)
        )
        sub_window_dbs = [_dbfs(float(r)) for r in sub_window_rms]
        return float(np.percentile(sub_window_dbs, 10))
