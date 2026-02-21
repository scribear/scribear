"""
Defines RealTimeLocationTracking
"""

import time
from typing import Dict, Optional


class LatencyTracker:
    """
    Simple per-session latency tracker using time.perf_counter()
    Usage Example:
        tracker = LatencyTracker()
        tracker.mark("audio_received")
    """

    def __init__(self) -> None:
        self._times: Dict[str, float] = {}
        self.start_time = time.perf_counter()

    def mark(self, name: str) -> None:
        """
        Docstring for mark

        :param self: Description
        :param name: Description
        :type name: str
        """
        self._times[name] = time.perf_counter()

    def get(self, name: str) -> Optional[float]:
        """
        Docstring for get

        :param self: Description
        :param name: Description
        :type name: str
        :return: Description
        :rtype: float | None
        """
        return self._times.get(name)

    def _delta_seconds(self, newer: str, older: str) -> Optional[float]:
        if newer in self._times and older in self._times:
            return self._times[newer] - self._times[older]
        return None

    def compute_deltas_ms(self) -> Dict[str, Optional[float]]:
        """
        Return deltas in milliseconds (rounded to 2 decimals).
        """
        deltas = {
            "vad_queue_ms": self._delta_seconds("vad_start", "audio_received"),
            "vad_process_ms": self._delta_seconds("vad_end", "vad_start"),
            "end_to_first_ms": self._delta_seconds(
                "first_transcript", "audio_received"
            ),
            "whisper_first_token_ms": self._delta_seconds(
                "first_transcript", "whisper_start"
            ),
            "asr_full_process_ms": self._delta_seconds(
                "whisper_end", "whisper_start"
            ),
            "total_latency_ms": self._delta_seconds(
                "whisper_end", "audio_received"
            ),
        }

        output = {}
        for key, value in deltas.items():
            output[key] = None if value is None else round(value * 1000.0, 2)

        return output

    def events_payload(self) -> Dict[str, float]:
        """
        Return recorded timestamps as epoch-relative
        perf_counter floars (not human time)
        """
        return {k: round(v, 6) for k, v in self._times.items()}

    def to_payload(self) -> Dict:
        """
        Docstring for to_payload

        :param self: Description
        :return: Description
        :rtype: Dict
        """
        return {
            "events": self.events_payload(),
            "deltas_ms": self.compute_deltas_ms(),
        }

    def reset(self) -> None:
        """
        Docstring for reset

        :param self: Description
        """
        self._times.clear()
        self.start_time = time.perf_counter()
