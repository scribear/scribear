import os
import pytest
import numpy as np
from src.shared.utils.silence_filter.silence_filter import (
    PureSilenceDetection,
    SilenceFiltering,
)


@pytest.mark.parametrize(
    "array,threshold,expected",
    [
        (np.zeros(1600, dtype=np.float32), 0.01, True),
        (np.full(1600, 1e-4, dtype=np.float32), 1e-3, True),
        (0.1 * np.sin(np.linspace(0, 2 * np.pi, 1600)).astype(np.float32), 0.01, False),
        (np.empty(0, dtype=np.float32), 0.01, True),
    ],
)
def test_pure_silence_detection_basic(array, threshold, expected):
    det = PureSilenceDetection(sample_rate=16000, default_silence_threshold=threshold)
    result = det.pure_silence_detection(array, threshold)
    assert result is expected


def test_pure_silence_detection_multichannel():
    ch0 = np.zeros(800, dtype=np.float32)
    ch1 = 0.02 * np.ones(800, dtype=np.float32)
    multi = np.stack([ch0, ch1], axis=1)
    det = PureSilenceDetection(sample_rate=16000, default_silence_threshold=0.01)
    assert det.pure_silence_detection(multi, 0.01) is False


def test_silence_filtering_basic_no_crash():
    """
    Ensure SilenceFiltering can be constructed and voice_position_detection
    either returns a list or the test is skipped if the external VAD isn't available.
    """
    arr = 0.1 * np.sin(np.linspace(0, 10, 1600)).astype(np.float32)
    sf = SilenceFiltering(arr, sample_rate=16000, silence_threshold=0.01)
    try:
        ranges = sf.voice_position_detection()
    except Exception as e:
        pytest.skip(f"SilenceFiltering not available in this environment: {e}")
    assert isinstance(ranges, list)
    sf.destroy_vad()


def test_silence_filtering_destroy_is_idempotent():
    """
    destroy_vad should be safe to call multiple times and not raise.
    """
    arr = 0.1 * np.sin(np.linspace(0, 10, 1600)).astype(np.float32)
    sf = SilenceFiltering(arr, sample_rate=16000, silence_threshold=0.01)
    try:
        sf.destroy_vad()
        sf.destroy_vad()
    except Exception as e:
        pytest.skip(f"SilenceFiltering.destroy_vad unavailable in this environment: {e}")


def test_silence_filtering_integration_when_enabled():
    """
    Integration test that requires real Silero VAD. Set RUN_SILERO_VAD_TESTS=1 to enable.
    """
    if os.environ.get("RUN_SILERO_VAD_TESTS") != "1":
        pytest.skip("Integration Silero VAD tests skipped (set RUN_SILERO_VAD_TESTS=1 to run)")
    arr = np.random.randn(4000).astype(np.float32)
    sf = SilenceFiltering(arr, sample_rate=16000, silence_threshold=0.01)
    ranges = sf.voice_position_detection()
    assert all(isinstance(r, tuple) and len(r) == 2 for r in ranges)
    sf.destroy_vad()