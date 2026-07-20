"""
Defines LumenGraniteProvider.

A remote, OpenAI-compatible transcription backend (wiki "Recipe B") that
forwards buffered audio to NCSA Lumen's `granite-speech-4.1-2b-plus` model. It
needs no local model/context, so its job registers with an empty context tag
tuple. Provider-wide config (endpoint, model, key env var, windowing) is shared
by every session; per-session `session_config` is ignored.
"""

# The provider/session wiring necessarily mirrors the other providers.
# pylint: disable=duplicate-code

from src.shared.logger import Logger
from src.shared.utils.worker_pool import JobException, JobSuccess, WorkerPool
from src.transcription_provider_interface import (
    AudioChunkPayload,
    TranscriptionProviderInterface,
    TranscriptionResult,
    TranscriptionSessionInterface,
)

from .lumen_granite_config import lumen_granite_config_adapter
from .lumen_granite_job import LumenGraniteProviderJob


class LumenGraniteProvider(TranscriptionProviderInterface):
    """
    TranscriptionProvider that transcribes audio via NCSA Lumen's Granite
    Speech model over its OpenAI-compatible HTTP endpoint.
    """

    class _LumenGraniteSession(TranscriptionSessionInterface):
        """
        Transcription session interface for LumenGraniteProvider.
        """

        def __init__(self, provider: "LumenGraniteProvider", logger: Logger):
            super().__init__()
            self._log = logger
            self._provider = provider

            self._job = provider.worker_pool.register_job(
                (),  # no context - remote endpoint does the work
                provider.config.job_period_ms,
                LumenGraniteProviderJob(provider.config),
            )
            self._job.on(self._job.JobResultEvent, self._handle_job_result)

        def _handle_job_result(
            self, result: JobSuccess[TranscriptionResult] | JobException
        ):
            if result.has_exception is True:
                self.emit(self.TranscriptionErrorEvent, result.value)
                return

            self.emit(self.TranscriptionResultEvent, result.value)

        def handle_audio_chunk(self, chunk_id: str, chunk: bytes):
            self._job.queue_data(
                [AudioChunkPayload(chunk_id=chunk_id, audio_bytes=chunk)]
            )

        def end_session(self):
            super().end_session()
            self._job.deregister()

    def __init__(
        self, provider_config: object, logger: Logger, worker_pool: WorkerPool
    ):
        self._log = logger
        self.config = lumen_granite_config_adapter.validate_python(
            provider_config
        )
        self.worker_pool = worker_pool

    def create_session(self, session_config: object, logger: Logger):
        return self._LumenGraniteSession(self, logger)

    def cleanup_provider(self):
        pass
