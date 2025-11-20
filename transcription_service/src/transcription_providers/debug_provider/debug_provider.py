"""
Defines DebugProvider that provides debugging information as "transcriptions"
"""

from src.shared.logger import Logger
from src.shared.utils.worker_pool import JobException, JobSuccess, WorkerPool
from src.transcription_provider_interface import (
    TranscriptionProviderInterface,
    TranscriptionResult,
    TranscriptionSequence,
    TranscriptionSessionInterface,
)

from .debug_provider_job import DebugProviderJob
from .debug_session_config import (
    DebugSessionConfig,
    debug_session_config_adapter,
)


class DebugProvider(TranscriptionProviderInterface):
    """
    TranscriptionProvider that provides debugging information as "transcriptions"
    """

    class _DebugSession(TranscriptionSessionInterface):
        """
        Transcription session inferface for DebugProvider
        """

        def __init__(
            self,
            provider: "DebugProvider",
            logger: Logger,
            config: DebugSessionConfig,
        ):
            super().__init__()
            self._logger = logger
            self._config = config

            self._job = provider.worker_pool.register_job(
                (), 1000, DebugProviderJob(self._config)
            )

            self._job.on(self._job.JobResultEvent, self._handle_job_result)

        def _handle_job_result(self, result: JobSuccess[float] | JobException):
            """
            Handles debug provider job result event

            Args:
                result  - Job result
            """
            if result.has_exception is True:
                self.emit(self.TranscriptionErrorEvent, result.value)
                return

            self.emit(
                self.TranscriptionResultEvent,
                TranscriptionResult(
                    in_progress=TranscriptionSequence(
                        text=[
                            f"Processed {result.value:.4f} seconds of audio. ",
                            f"Decode job took {result.stats.execution_time_ns} nanoseconds. ",
                        ]
                    )
                ),
            )

        def start_session(self):
            self.emit(
                self.TranscriptionResultEvent,
                TranscriptionResult(
                    final=TranscriptionSequence(
                        text=[
                            f"Session sample rate: {self._config.sample_rate}. ",
                            f"Session channel count: {self._config.num_channels}. ",
                        ]
                    )
                ),
            )

        def handle_audio_chunk(self, chunk: bytes):
            self._job.queue_data([chunk])

        def end_session(self):
            super().end_session()
            self._job.deregister()

    def __init__(
        self, provider_config: object, logger: Logger, worker_pool: WorkerPool
    ):
        self._log = logger
        self.worker_pool = worker_pool

    def create_session(self, session_config: object, logger: Logger):
        config = debug_session_config_adapter.validate_python(session_config)
        return self._DebugSession(self, logger, config)

    def cleanup_provider(self):
        pass
