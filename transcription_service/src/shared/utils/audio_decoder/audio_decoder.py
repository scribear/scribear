"""
Defines AudioDecoder for handling decoding audio chunks into specified formats
"""

import io
from enum import Enum
from typing import Any

import numpy.typing as npt
import soundfile as sf


class TargetFormat(Enum):
    """
    Defines available target formats and maps to soundfile library dtype option
    """

    FLOAT_32 = "float32"
    FLOAT_64 = "float64"


class AudioDecoder:
    """
    Handles decoding audio chunks in various audio formats into numpy array of specified type
    Decoding throws ValueError if provided chunk does not have correct sample rate or
        number of channels

    Target formats:
        FLOAT_32        : Audio samples range in [-1, 1) in numpy float32 array
        FLOAT_64        : Audio samples range in [-1, 1) in numpy float64 array
    """

    def __init__(
        self, sample_rate: int, num_channels: int, target_format: TargetFormat
    ):
        """ """
        self._sample_rate = sample_rate
        self._num_channels = num_channels
        self._dtype = target_format

    def decode(self, audio_data: bytes) -> npt.NDArray[Any]:
        """
        Decodes audio bytes into specified format

        Args:
            audio_data  - The raw byte content of audio data to decode

        Returns:
            Audio data in the target format as a numpy array.

        Raises:
            ValueError if the source audio does not have correct sample rate or number of channels
        """
        try:
            with sf.SoundFile(io.BytesIO(audio_data), "r") as audio_file:
                if audio_file.samplerate != self._sample_rate:
                    raise ValueError(
                        f"Sample rate mismatch: Required {self._sample_rate}, "
                        f"but audio data has {audio_file.samplerate}."
                    )
                if audio_file.channels != self._num_channels:
                    raise ValueError(
                        f"Channel count mismatch: Required {self._num_channels}, "
                        f"but audio data has {audio_file.channels}."
                    )

                return audio_file.read(dtype=self._dtype.value)
        except sf.LibsndfileError as e:
            raise ValueError("Failed to decode audio data.") from e
