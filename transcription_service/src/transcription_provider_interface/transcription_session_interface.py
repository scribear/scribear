"""
Defines TranscriptionSessionInterface API for transcription providers
"""

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

from src.shared.logger import Logger
from src.shared.utils.event_emitter import Event, EventEmitter

from .transcription_client_error import TranscriptionClientError
from .transcription_result import TranscriptionResult

if TYPE_CHECKING:
    # Import-cycle-free because it is type-checking only: the provider
    # interface imports this module at runtime, not the other way round.
    from .transcription_provider_interface import TranscriptionProviderInterface


class TranscriptionSessionInterface(ABC, EventEmitter):
    """
    Defines interface for providing transcriptions for a single transcription session

    Implementations must define handle_audio_chunk
    Implementations can override start_session to send transcription when session begins
    Implementations can override end_session if resources need to be cleaned up

    When transcriptions are ready, implementations should emit a TranscriptionResultEvent
    """

    TranscriptionResultEvent = Event[TranscriptionResult](
        "TRANSCRIPTION_RESULT"
    )
    TranscriptionErrorEvent = Event[TranscriptionClientError | Exception](
        "TRANSCRIPTION_ERROR"
    )

    # Opaque identifiers passed into create_session(), stored uniformly here
    # rather than left to each implementation to invent its own attribute
    # names. This service is still session-blind: nothing here reads them,
    # they exist only so a future consumer can (monitoring dashboard plan
    # Part 2).
    session_uid: str | None = None
    room_uid: str | None = None

    # The worker-pool JobHandle this session registered on its first audio
    # chunk, or None while it has registered nothing. Declared here, not only
    # in each implementation's __init__, because `_admit_registered_job` below
    # owns the undo on a refusal and therefore has to be able to clear it.
    # `Any` rather than `JobHandle[...]`: every provider parameterises the
    # handle with its own data/result/config types, and the only thing this
    # class ever does with it is `deregister()`.
    _job: Any = None

    def _admit_registered_job(
        self, provider: "TranscriptionProviderInterface", logger: Logger
    ) -> None:
        """
        Asks whether the worker this session's just-registered job landed on
        has room for it, and undoes the registration if it does not

        Args:
            provider    - Provider this session belongs to; its
                            `check_admission` carries the binding the registry
                            attached at load time
            logger      - Logger a refusal is attached to

        Called from a session's `_ensure_job`, immediately after `register_job`
        returns and before any data is queued to the job - so a refusal costs
        the worker nothing beyond the registration undone here.

        THE UNDO IS UNCONDITIONAL, AND SHARED ON PURPOSE. It used to be written
        out inside `whisper_streaming_provider` alone, while `debug` and
        `lumen_granite` called `check_admission` bare. That was safe only for
        as long as neither of those two overrode `admission_worker_id` - an
        invariant asserted in three docstrings and enforced by nothing.
        Overriding that property is a one-line change in a provider with no
        reason to know it would leak a job, and the leak is silent: the worker
        keeps scheduling a job every period for a session no client ever
        received, consuming exactly the capacity the refusal existed to
        protect, and nothing ever calls `end_session` on a session the caller
        never got back. So register/ask/undo is one thing all three sessions
        call, rather than a shape each is trusted to reproduce.

        Clearing `self._job` is what stops `admission_worker_id` continuing to
        claim a worker this session was refused. Deregistration is idempotent
        (`JobHandle.deregister`), so the `end_session` teardown that runs later
        is unaffected either way.
        """
        if self._job is None:
            return

        try:
            provider.check_admission(self.admission_worker_id, logger)
        except BaseException:
            self._job.deregister()
            self._job = None
            raise

    @property
    def admission_worker_id(self) -> int | None:
        """
        Gets the pool worker this session's compute landed on, or None if the
        session is not subject to local worker-pool capacity admission, or if
        it has not yet claimed a worker at all

        Which worker a session lands on is decided by live load balancing at
        `register_job` time (`WorkerPool._assign_process` picks the least
        utilized worker owning every required context tag), so it is not
        knowable before a job is registered. Registration itself is deferred
        to the session's first real audio chunk (an idle, audio-less
        connection registers no job and so is never a capacity claim on
        anything), which is why this reads None right up until then even for
        a provider that overrides it - and why the answer has to come off the
        session object rather than be asked of the registry, which never sees
        the JobHandle.

        None is also a positive statement once a job does exist, not only a
        "not yet" state. It means "this session's cost is not a claim on a
        local worker's ASR throughput, so the per-worker capacity estimate
        does not describe it" - the shape
        `archived-plans/2026-07-27-02-PLAN-AdmissionControl.md` §5 already
        uses for a remote provider's capacity, which is reported as "not
        applicable" rather than as a fabricated number. Defaulting to None is
        also the safe direction under this plan's stated posture: a provider
        added later is admitted rather than refused until someone deliberately
        opts it in, and an over-admission is visible and self-corrects while a
        wrong refusal is invisible to everyone including us.

        Concretely, of the three shipped providers only `whisper-streaming`
        overrides this. `lumen_granite` is a remote-API provider whose capacity
        question is upstream rate limits and network latency, explicitly out of
        scope per §5/§7; `debug` does no ASR work at all. Both register jobs
        with an empty context tag tuple, so the worker they land on is whichever
        happened to be least utilized rather than a placement onto the model
        that would serve them.
        """
        return None

    def start_session(self):
        """
        Called after a transcription session is created and event handlers are registered
        """

    @abstractmethod
    def handle_audio_chunk(self, chunk_id: str, chunk: bytes):
        """
        Called when when an audio chunk arrives from audio stream
        Note: chunk can be any length and format

        Args:
            chunk_id    - Correlation id for this chunk, echoed back with the
                            transcript it contributes to so the caller can
                            measure latency. Empty string if unknown.
            chunk       - Chunk of audio to handle

        Raises:
            TranscriptionClientError if error is caused by client
                (e.g. misconfiguration, invalid audio, etc.)
            Any other Exception if error is server-side
        """

    def end_session(self):
        """
        Called when a transcription session ends to cleanup resources
        """
        self.remove_all_listeners()
