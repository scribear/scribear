"""
Defines WorkerPool job for DebugProvider that returns number of seconds of audio received
"""

from src.shared.logger import Logger
from src.shared.utils.audio_decoder import AudioDecoder, TargetFormat
from src.shared.utils.worker_pool import JobInterface
from src.transcription_provider_interface import TranscriptionClientError

from .debug_session_config import DebugSessionConfig


class DebugProviderJob(JobInterface[None, bytes, float]):
    """
    WorkerPool job definition for DebugProvider
    Decodes audio chunks and returns number of seconds of audio received
    """

    def __init__(self, config: DebugSessionConfig):
        self._sample_rate = config.sample_rate
        self._decoder = AudioDecoder(
            config.sample_rate, config.num_channels, TargetFormat.FLOAT_32
        )

    def process_batch(
        self, log: Logger, context: None, batch: list[bytes]
    ) -> float:
        if len(batch) == 0:
            return 0

        samples_decoded = 0
        for chunk in batch:
            try:
                segments = self._decoder.decode(chunk)
            except ValueError as e:
                raise TranscriptionClientError(str(e)) from e
            samples_decoded += len(segments)

        return samples_decoded / self._sample_rate
