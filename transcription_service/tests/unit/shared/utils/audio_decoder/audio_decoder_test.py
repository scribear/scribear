"""
Unit tests for AudioDecoder
"""

from os import path
from typing import Any

import numpy as np
import numpy.typing as npt
import pytest

from src.shared.utils.audio_decoder import AudioDecoder, TargetFormat


def cosine_similarity(vec1: npt.NDArray[Any], vec2: npt.NDArray[Any]) -> float:
    """
    Compute the cosine similarity between numpy arrays
    """
    vec1 = vec1.flatten()
    vec2 = vec2.flatten()
    return np.dot(vec1, vec2) / (np.linalg.norm(vec1) * np.linalg.norm(vec2))


AUDIO_DIR = path.normpath(
    path.join(
        __file__,
        "..",
        "..",
        "..",
        "..",
        "..",
        "..",
        "..",
        "test_audio_files/chords",
    )
)

CH_0_F64 = np.fromfile(path.join(AUDIO_DIR, "ch0_f64le.pcm"), dtype=np.float64)
CH_1_F64 = np.fromfile(path.join(AUDIO_DIR, "ch1_f64le.pcm"), dtype=np.float64)
CH_2_F64 = np.fromfile(path.join(AUDIO_DIR, "ch2_f64le.pcm"), dtype=np.float64)
CH_3_F64 = np.fromfile(path.join(AUDIO_DIR, "ch3_f64le.pcm"), dtype=np.float64)

QUAD_F64 = np.stack((CH_0_F64, CH_1_F64, CH_2_F64, CH_3_F64), axis=0).T
MONO_F64 = np.fromfile(path.join(AUDIO_DIR, "mono_f64le.pcm"), dtype=np.float64)


def test_valid_decode_wav_float_64_1ch_to_float_64():
    """
    Test that audio decode correctly decodes 1 channel float64 wav into float64 array
    """
    # Arrange
    audio_decoder = AudioDecoder(48000, 1, TargetFormat.FLOAT_64)
    with open(path.join(AUDIO_DIR, "mono_f64le.wav"), "rb") as f:
        chunk = f.read()

    # Act
    decoded = audio_decoder.decode(chunk)

    # Assert
    assert decoded.dtype == np.float64
    assert np.max(decoded) <= 1
    assert np.min(decoded) >= -1
    assert cosine_similarity(decoded, MONO_F64) > 0.99


def test_valid_decode_wav_float_64_4ch_to_float_64():
    """
    Test that audio decode correctly decodes 4 channel float64 wav into float64 array
    """
    # Arrange
    audio_decoder = AudioDecoder(48000, 4, TargetFormat.FLOAT_64)
    with open(path.join(AUDIO_DIR, "quad_f64le.wav"), "rb") as f:
        chunk = f.read()

    # Act
    decoded = audio_decoder.decode(chunk)

    # Assert
    assert decoded.dtype == np.float64
    assert np.max(decoded) <= 1
    assert np.min(decoded) >= -1
    assert cosine_similarity(decoded, QUAD_F64) > 0.99


def test_valid_decode_wav_float_32_4ch_to_float_32():
    """
    Test that audio decode correctly decodes 4 channel float32 wav into float32 array
    """
    # Arrange
    audio_decoder = AudioDecoder(48000, 4, TargetFormat.FLOAT_32)
    with open(path.join(AUDIO_DIR, "quad_f32le.wav"), "rb") as f:
        chunk = f.read()

    # Act
    decoded = audio_decoder.decode(chunk)

    # Assert
    assert decoded.dtype == np.float32
    assert np.max(decoded) <= 1
    assert np.min(decoded) >= -1
    assert cosine_similarity(decoded, QUAD_F64) > 0.99


def test_valid_decode_wav_float_32_4ch_to_float_64():
    """
    Test that audio decode correctly decodes 4 channel float32 wav into float64 array
    """
    # Arrange
    audio_decoder = AudioDecoder(48000, 4, TargetFormat.FLOAT_64)
    with open(path.join(AUDIO_DIR, "quad_f32le.wav"), "rb") as f:
        chunk = f.read()

    # Act
    decoded = audio_decoder.decode(chunk)

    # Assert
    assert decoded.dtype == np.float64
    assert np.max(decoded) <= 1
    assert np.min(decoded) >= -1
    assert cosine_similarity(decoded, QUAD_F64) > 0.99


def test_valid_decode_wav_sint_16_4ch_to_float_64():
    """
    Test that audio decode correctly decodes 4 channel sint16 wav into float64 array
    """
    # Arrange
    audio_decoder = AudioDecoder(48000, 4, TargetFormat.FLOAT_64)
    with open(path.join(AUDIO_DIR, "quad_s16le.wav"), "rb") as f:
        chunk = f.read()

    # Act
    decoded = audio_decoder.decode(chunk)

    # Assert
    assert decoded.dtype == np.float64
    assert np.max(decoded) <= 1
    assert np.min(decoded) >= -1
    assert cosine_similarity(decoded, QUAD_F64) > 0.99


def test_valid_decode_wav_uint_8_4ch_to_float_64():
    """
    Test that audio decode correctly decodes 4 channel uint8 wav into float64 array
    """
    # Arrange
    audio_decoder = AudioDecoder(48000, 4, TargetFormat.FLOAT_64)
    with open(path.join(AUDIO_DIR, "quad_u8.wav"), "rb") as f:
        chunk = f.read()

    # Act
    decoded = audio_decoder.decode(chunk)

    # Assert
    assert decoded.dtype == np.float64
    assert np.max(decoded) <= 1
    assert np.min(decoded) >= -1
    assert cosine_similarity(decoded, QUAD_F64) > 0.99


def test_rejects_invalid_audio():
    """
    Test that audio decode correctly throws error when given invalid audio data
    """
    # Arrange
    audio_decoder = AudioDecoder(48000, 4, TargetFormat.FLOAT_64)
    chunk = bytes(10)

    # Act / Assert
    with pytest.raises(ValueError):
        audio_decoder.decode(chunk)


def test_rejects_sample_rate_mismatch():
    """
    Test that audio decode correctly throws error when request sample rate
        doesn't match audio chunk sample rate
    """
    # Arrange
    audio_decoder = AudioDecoder(16000, 1, TargetFormat.FLOAT_64)
    with open(path.join(AUDIO_DIR, "mono_f64le.wav"), "rb") as f:
        chunk = f.read()

    # Act / Assert
    with pytest.raises(ValueError):
        audio_decoder.decode(chunk)


def test_rejects_channel_count_mismatch():
    """
    Test that audio decode correctly throws error when request num channels
        doesn't match audio chunk num channels
    """
    # Arrange
    audio_decoder = AudioDecoder(48000, 4, TargetFormat.FLOAT_64)
    with open(path.join(AUDIO_DIR, "mono_f64le.wav"), "rb") as f:
        chunk = f.read()

    # Act / Assert
    with pytest.raises(ValueError):
        audio_decoder.decode(chunk)
