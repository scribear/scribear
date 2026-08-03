"""
Defines FasterWhisperStreamingProvider
"""

# The provider/session wiring necessarily mirrors the other providers.
# pylint: disable=duplicate-code

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

            # Not registered here - see _ensure_job. An idle client that never
            # sends audio must never take a worker's job slot, which is also
            # why admission_worker_id below has to tolerate self._job being
            # None.
            self._job = None

            self._provider.session_started()

        @property
        def admission_worker_id(self) -> int | None:
            """
            The worker this session's transcription job was actually assigned
            to, read off the handle register_job returned - or None if no job
            has been registered yet

            Read from the JobHandle rather than recomputed, because the pool's
            choice is made from live utilization at registration time and any
            second derivation of it would be a guess about a decision that has
            already been made. This is the only shipped provider that overrides
            it: local ASR compute on a pool worker is exactly what the capacity
            estimator measures.

            None before the first audio chunk is exactly the same "not a
            capacity claim yet" statement the base class makes for a provider
            excluded outright - see
            TranscriptionSessionInterface.admission_worker_id.
            """
            return self._job.worker_id if self._job is not None else None

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

        def _ensure_job(self) -> None:
            """
            Registers this session's worker-pool job on the first real audio
            chunk, not at construction

            Deferred so an idle client - configured but never streaming - never
            takes a worker's job slot, and so never counts toward that
            worker's live_job_count for capacity admission
            (PLAN-AdmissionControl.md §4). `_admit_registered_job` is called
            immediately after registering, before any data is queued to the
            job, so a refusal can undo the registration and raise before this
            chunk is ever processed - the same "build then undo" shape
            admission used at construction time, just relocated to where
            registration itself now happens. That undo lives on
            TranscriptionSessionInterface rather than here, so all three
            providers get it identically.

            A `register_job` that raises (context tags misconfigured, per
            `describe_health`'s "routed here dies at register_job") now
            surfaces on the first audio chunk instead of at CONFIG time; the
            readiness probe and per-provider health already report that
            misconfiguration independently, so a client still finds out, just
            not until it would have needed the worker anyway.
            """
            if self._job is not None:
                return

            self._job = self._provider.worker_pool.register_job(
                (
                    self._provider.config.whisper_context_tag,
                    self._provider.config.silero_context_tag,
                ),
                self._provider.config.job_period_ms,
                WhisperStreamingProviderJob(self._provider.config),
                self._provider.provider_key,
                session_uid=self.session_uid,
                room_uid=self.room_uid,
            )
            self._job.on(self._job.JobResultEvent, self._handle_job_result)
            self._admit_registered_job(self._provider, self._log)

        def handle_audio_chunk(self, chunk_id: str, chunk: bytes):
            self._ensure_job()
            self._job.queue_data(
                [AudioChunkPayload(chunk_id=chunk_id, audio_bytes=chunk)]
            )

        def end_session(self):
            super().end_session()
            if self._job is not None:
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

    @property
    def job_period_ms(self) -> int | None:
        # The same field the session passes to register_job, read from the same
        # config object, so the reported period cannot drift from the scheduled
        # one.
        return self.config.job_period_ms

    @property
    def context_tags(self) -> list[str]:
        # The registry resolves this tag against its tag-to-device map to
        # report `providerDevice` on /metrics/status — the provider itself
        # does not have access to the context's config, so the registry does
        # the lookup rather than the provider.
        return [self.config.whisper_context_tag]

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
