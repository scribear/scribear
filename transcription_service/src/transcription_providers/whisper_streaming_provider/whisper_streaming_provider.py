"""
Defines FasterWhisperStreamingProvider
"""

from dataclasses import asdict

from src.shared.logger import Logger
from src.shared.utils.worker_pool import (
    JobException,
    JobSuccess,
    WorkerPool,
    is_saturated,
)
from src.transcription_provider_interface import (
    AudioChunkPayload,
    ProviderHealth,
    ProviderKind,
    ProviderStatus,
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
            self,
            provider: "WhisperStreamingProvider",
            logger: Logger,
            session_uid: str | None,
            room_uid: str | None,
        ):
            super().__init__()
            self._log = logger
            self._provider = provider
            # Opaque; stored for a future consumer (Part 2), not read here.
            self.session_uid = session_uid
            self.room_uid = room_uid

            self._job = provider.worker_pool.register_job(
                (
                    self._provider.config.whisper_context_tag,
                    self._provider.config.silero_context_tag,
                ),
                self._provider.config.job_period_ms,
                WhisperStreamingProviderJob(self._provider.config),
                self._provider.provider_key,
            )
            self._job.on(self._job.JobResultEvent, self._handle_job_result)

            # Last, so a registration that raises above never counts a session
            # that did not open.
            self._provider.session_started()

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

        def handle_audio_chunk(self, chunk_id: str, chunk: bytes):
            self._job.queue_data(
                [AudioChunkPayload(chunk_id=chunk_id, audio_bytes=chunk)]
            )

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
        self.config = whisper_streaming_config_adapter.validate_python(
            provider_config
        )
        self.worker_pool = worker_pool
        self.provider_key = provider_key

    def create_session(
        self,
        session_config: object,
        session_uid: str | None,
        room_uid: str | None,
        logger: Logger,
    ):
        # Session config was already unused before session_uid/room_uid
        # existed; accepted for interface parity only.
        del session_config
        return self._WhisperStreamingSession(
            self, logger, session_uid, room_uid
        )

    async def describe_health(self):
        """
        Gets health of this local model provider

        Reads in-memory worker state only - no I/O, so polling this cannot
        perturb transcription.

        The failure this exists to catch: `worker_ids`/`tags` misconfigured so
        that no live worker owns both the whisper and silero contexts. The pool
        is then perfectly healthy and readiness returns 200, but every session
        routed here dies at `register_job`. Nothing detected that before B1.7.
        """
        tags = (self.config.whisper_context_tag, self.config.silero_context_tag)
        owning_workers = self.worker_pool.load_for_tags(tags)
        model_loaded = len(owning_workers) > 0

        if not model_loaded:
            status = ProviderStatus.DOWN
            detail = (
                f"no live worker owns contexts {tags}; check worker_ids and "
                "tags in provider_config"
            )
        elif all(is_saturated(w) for w in owning_workers):
            # Every worker that could take this provider's work is pinned. The
            # provider still transcribes, just behind realtime.
            status = ProviderStatus.DEGRADED
            detail = (
                f"all {len(owning_workers)} workers serving this provider are "
                "saturated; transcription will fall behind realtime"
            )
        else:
            status = ProviderStatus.OK
            detail = None

        return ProviderHealth(
            kind=ProviderKind.LOCAL,
            status=status,
            active_sessions=self.active_sessions,
            # The model name lives on the context config, not here - this
            # provider only holds the tag that routes to it.
            model=None,
            model_loaded=model_loaded,
            owning_workers=owning_workers,
            detail=detail,
        )

    def cleanup_provider(self):
        pass
