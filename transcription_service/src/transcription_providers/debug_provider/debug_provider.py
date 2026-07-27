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

from .debug_provider_job import DebugJobResult, DebugProviderJob
from .debug_session_config import (
    DebugSessionConfig,
    debug_session_config_adapter,
)

# Job period for this provider. Unlike every other provider this is not
# configurable - there is no debug provider config - so it is stated here once
# and read both by register_job below and by `job_period_ms`, which reports it
# to the monitoring sidecar. Two literals would let the reported period drift
# from the scheduled one, which is exactly the bug reporting it is meant to end.
DEBUG_JOB_PERIOD_MS = 1000


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
            session_uid: str | None,
            room_uid: str | None,
        ):
            super().__init__()
            self._logger = logger
            self._config = config
            self._provider = provider
            # Opaque; stored for a future consumer (Part 2), not read here.
            self.session_uid = session_uid
            self.room_uid = room_uid

            self._job = provider.worker_pool.register_job(
                (),
                DEBUG_JOB_PERIOD_MS,
                DebugProviderJob(self._config),
                provider.provider_key,
                session_uid=self.session_uid,
                room_uid=self.room_uid,
            )

            self._job.on(self._job.JobResultEvent, self._handle_job_result)

            # Last, so a registration that raises above never counts a session
            # that did not open.
            provider.session_started()

        def _handle_job_result(
            self, result: JobSuccess[DebugJobResult] | JobException
        ):
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
                            f"Processed {result.value.seconds_decoded:.4f} seconds of audio. ",
                            f"Decode job took {result.stats.execution_time_ns} nanoseconds. ",
                        ]
                    ),
                    # Carried through untouched: the job is the only thing that
                    # can measure its own decode, and the execution timing
                    # above is the only part of this result the session owns.
                    audio_stages=result.value.audio_stages,
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

        def handle_audio_chunk(self, chunk_id: str, chunk: bytes):
            # Debug provider does not track chunk ids; the correlation id is
            # accepted for interface parity and ignored.
            del chunk_id
            self._job.queue_data([chunk])

        def end_session(self):
            super().end_session()
            self._job.deregister()
            self._provider.session_ended()

    def __init__(
        self,
        provider_config: object,
        logger: Logger,
        worker_pool: WorkerPool,
        provider_key: str,
    ):
        self._log = logger
        self.worker_pool = worker_pool
        self.provider_key = provider_key

    @property
    def job_period_ms(self) -> int | None:
        return DEBUG_JOB_PERIOD_MS

    def create_session(
        self,
        session_config: object,
        session_uid: str | None,
        room_uid: str | None,
        logger: Logger,
    ):
        config = debug_session_config_adapter.validate_python(session_config)
        return self._DebugSession(self, logger, config, session_uid, room_uid)

    def cleanup_provider(self):
        pass
