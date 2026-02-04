import logging
import numpy as np
import numpy.typing as npt

logger = logging.getLogger(__name__)
class RMSSilenceDetection:
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

    def detect(
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

