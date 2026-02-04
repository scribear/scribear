"""
Defines PureSilenceDetection and SilenceFiltering
"""

import logging

import numpy as np
import numpy.typing as npt
import torch

logger = logging.getLogger(__name__)


class PureSilenceDetection:
    """
    Fast heuristic checks (peak + RMS) to detect near-silence in audio.
    """

    def __init__(
        self,
        sample_rate: int = 16000,
        default_silence_threshold: float = 0.01,
        mix_to_mono=True,
    ):
        self.sample_rate = int(sample_rate)
        self.silence_threshold = float(default_silence_threshold)
        self.mix_to_mono = bool(
            mix_to_mono
        )  # mix multi-D channels into 1D channel
        self._expects_float32 = True
        self.expects_contiguous = True

    def pure_silence_detection(
        self, audio_array: npt.NDArray, silence_threshold: float
    ) -> bool:
        """
        Return True when audio is considered pure silence by RMS/peak thresholds.
        """
        if audio_array is None:
            return True
        array = np.asarray(audio_array)
        if array.size == 0:
            return True
        if array.ndim > 1:
            array = array.mean(axis=1)
        array = np.ascontiguousarray(array, dtype=np.float32)
        if array.size == 0:
            return True
        max_abs = float(np.max(np.abs(array)))
        rms = float(np.sqrt(np.mean(np.square(array), dtype=np.float64)))
        return (max_abs <= float(silence_threshold)) and (
            rms <= float(silence_threshold)
        )


class SilenceFiltering:
    """
    Silero-based VAD wrapper that expects a pre-loaded model.
    """

    def __init__(
        self,
        audio_array: npt.NDArray,
        sample_rate: int,
        vad_model,
        get_speech_timestamps,
        threshold=0.5,
        neg_threshold=None,
    ):
        self.sample_rate = int(sample_rate)
        self._vad_model = vad_model
        self._get_speech_timestamps = get_speech_timestamps
        self.threshold = threshold
        self.neg_threshold = neg_threshold
        array = None
        if audio_array is not None:
            arr = np.asarray(audio_array)
            if arr.ndim > 1:
                arr = arr.mean(axis=1)
            if arr.size > 0:
                array = np.ascontiguousarray(arr, dtype=np.float32)
            else:
                array = np.empty(0, dtype=np.float32)
        self._array = array

    def voice_position_detection(
        self, audio_array: npt.NDArray | None = None
    ) -> list:
        """
        Return list of (start_sample, end_sample) detected as speech.
        """
        array = None
        if audio_array is not None:
            arr = np.asarray(audio_array)
            if arr.ndim > 1:
                arr = arr.mean(axis=1)
            array = np.ascontiguousarray(arr, dtype=np.float32)
        elif self._array is not None:
            array = self._array
        else:
            return []
        if self._get_speech_timestamps is None or self._vad_model is None:
            logger.error("VAD model or utils not provided to SilenceFiltering")
            return []
        # prepare for the future that user can set the threshold,
        # if user does not initialize the threshold, neg_threshold will be 0
        neg_th = self.neg_threshold
        if neg_th is None:
            neg_th = max(0.01, self.threshold - 0.15)
        neg_th = min(neg_th, self.threshold - 0.001)
        try:
            with torch.inference_mode():
                wave = torch.from_numpy(array).float()
                if wave.ndim > 1:
                    wave = wave.mean(dim=1)
                time_stamps = self._get_speech_timestamps(
                    wave,
                    self._vad_model,
                    sampling_rate=self.sample_rate,
                    # above the threshold value -> start vad, recommend value is 0.5
                    threshold=self.threshold,
                    # below than neg_threshold -> stop vad, default value is threshold - 0.15
                    neg_threshold=neg_th,
                    return_seconds=False,
                )
        except (RuntimeError, OSError, TypeError) as exc:
            logger.error("Silero VAD inference failed: %s", exc, exc_info=True)
            return []

        if not time_stamps:
            return []

        ranges = []
        length = len(wave)
        for time in time_stamps:
            start = int(time.get("start", 0))
            end = int(time.get("end", 0))

            start = max(0, min(start, length))
            end = max(0, min(end, length))
            if end > start:
                ranges.append((start, end))
        return ranges
