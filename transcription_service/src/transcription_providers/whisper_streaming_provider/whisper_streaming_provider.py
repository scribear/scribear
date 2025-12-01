"""
Defines FasterWhisperStreamingProvider
"""

from dataclasses import asdict

from src.shared.logger import Logger
from src.shared.utils.worker_pool import JobException, JobSuccess, WorkerPool
from src.transcription_contexts.faster_whisper_context import (
    FasterWhisperContext,
)
from src.transcription_contexts.silero_vad_context import SileroVadContext
from src.transcription_provider_interface import (
    TranscriptionProviderInterface,
    TranscriptionResult,
    TranscriptionSessionInterface,
)

from .whisper_streaming_config import whisper_streaming_config_adapter
from .whisper_streaming_job import WhisperStreamingProviderJob


class WhisperStreamingProvider(TranscriptionProviderInterface):
    """
    TranscriptionProvider that implements WhisperStreaming algorithm
    described in (Macháček et al.)

    @inproceedings{machacek-etal-2023-turning,
        title = "Turning Whisper into Real-Time Transcription System",
        author = "Mach{\'a}{\v{c}}ek, Dominik  and
        Dabre, Raj  and
        Bojar, Ond{\v{r}}ej",
        editor = "Saha, Sriparna  and
        Sujaini, Herry",
        booktitle = "Proceedings of the 13th International Joint Conference on Natural
            Language Processing and the 3rd Conference of the Asia-Pacific Chapter of the
            Association for Computational Linguistics: System Demonstrations",
        month = nov,
        year = "2023",
        address = "Bali, Indonesia",
        publisher = "Association for Computational Linguistics",
        url = "https://aclanthology.org/2023.ijcnlp-demo.3",
        pages = "17--24",
    }
    """

    class _WhisperStreamingSession(TranscriptionSessionInterface):
        """
        Transcription session inferface for WhisperStreamingProvider
        """

        def __init__(
            self, provider: "WhisperStreamingProvider", logger: Logger
        ):
            super().__init__()
            self._log = logger
            self._provider = provider

            self._job = provider.worker_pool.register_job(
                (
                    self._provider.config.context_tag,
                    self._provider.config.vad_context_tag,
                ),
                self._provider.config.job_period_ms,
                WhisperStreamingProviderJob(self._provider.config),
            )
            self._job.on(self._job.JobResultEvent, self._handle_job_result)

        def _handle_job_result(
            self, result: JobSuccess[TranscriptionResult] | JobException
        ):
            if result.has_exception is True:
                self.emit(self.TranscriptionErrorEvent, result.value)
                return

            self._log.info(
                "Completed transcription job",
                context={
                    "stats": asdict(result.stats),
                    "final": (
                        str(result.value.final)
                        if result.value.final is not None
                        else None
                    ),
                    "in_progress": (
                        str(result.value.in_progress)
                        if result.value.in_progress is not None
                        else None
                    ),
                },
            )
            self.emit(self.TranscriptionResultEvent, result.value)

        def handle_audio_chunk(self, chunk: bytes):
            self._job.queue_data([chunk])

        def end_session(self):
            super().end_session()
            self._job.deregister()

    def __init__(
        self, provider_config: object, logger: Logger, worker_pool: WorkerPool
    ):
        self._log = logger
        self.config = whisper_streaming_config_adapter.validate_python(
            provider_config
        )

        # Check that configured worker context provides a Whisper model
        worker_pool.tagged_context_is_instance(
            self.config.context_tag, [FasterWhisperContext]
        )
        try:
            worker_pool.tagged_context_is_instance(
                self.config.vad_context_tag, [SileroVadContext]
            )
        except Exception as e:
            self._log.error(
                f"VAD Context '{self.config.vad_context_tag}' not found or invalid: {e}"
            )
            raise e

        self.worker_pool = worker_pool

    def create_session(self, session_config: object, logger: Logger):
        return self._WhisperStreamingSession(self, logger)

    def cleanup_provider(self):
        pass
