"""
Defines TranscriptionProviderInterface API for transcription providers
"""

from abc import ABC, abstractmethod
from typing import Callable

from src.shared.logger import Logger
from src.shared.utils.worker_pool import WorkerPool

from .provider_health import ProviderHealth, ProviderKind, ProviderStatus
from .transcription_session_interface import TranscriptionSessionInterface


class TranscriptionProviderInterface(ABC):
    """
    Defines interface for providing transcriptions for a single transcription session

    Implementations should:
    - Define handler for begin_session() an returns TranscriptionSessionInterface implementation
    - Define handler for end_session()

    It is acceptable for this class to throw Exceptions for fatal exceptions.
    For other exceptions, a TranscriptionError or ValidationError should be used
        Only begin_session() should only throw TranscriptionError or ValidationError
        A transcription session should emit a TranscriptionErrorEvent instead of throwing exceptions
    """

    @abstractmethod
    def __init__(
        self,
        provider_config: object,
        logger: Logger,
        worker_pool: WorkerPool,
        provider_key: str,
    ):
        """
        Args:
            provider_config - Provider configuration object unique to transcription provider
            logger          - Application logger
            worker_pool     - Application worker pool to dispatch compute heavy work to
            provider_key    - Configured key this provider was registered under.
                                Passed to register_job as the job label so worker
                                pool telemetry can be grouped by provider.
        """

    @abstractmethod
    def create_session(
        self,
        session_config: object,
        session_uid: str | None,
        room_uid: str | None,
        logger: Logger,
    ) -> TranscriptionSessionInterface:
        """
        Called when a transcription session is requested
        start_session() should be called on session returned after event handlers are registered

        This function (and this function only) should only throw
            TranscriptionError or ValidationError exceptions.

        Note: The schema of session_config should be validated and
            TranscriptionClientError thrown if invalid.

        Args:
            session_config  - Session configuration object unique to transcription provider
            session_uid     - Opaque session identifier from the caller, if
                                known. Not validated or used for anything
                                beyond storage on the returned session.
            room_uid        - Opaque room identifier from the caller, if
                                known. Same handling as session_uid.
            logger          - Application logger for session to use

        Returns:
            Object implementing TranscriptionSessionInterface
        """

    @abstractmethod
    def cleanup_provider(self):
        """
        Called when application exits
        Should cleanup resources used by TranscriptionProvider
        """

    # Session accounting and health reporting are concrete, not abstract: a
    # provider that never opts in still reports a truthful (if opaque) health
    # entry, so adding a provider cannot silently create a blind spot on the
    # dashboard.

    # Declared on the class rather than set in __init__ because implementations
    # define their own __init__ and none of them chain to super(). Ints are
    # immutable, so the first increment rebinds it as an instance attribute and
    # no state is ever shared between providers.
    _active_sessions: int = 0

    # None until `bind_admission_check` wires one on, which
    # TranscriptionProviderRegistry does right after constructing this
    # provider. A provider built directly - every provider unit test does
    # this - therefore admits unconditionally, the same fail-open default
    # admission control has used from the start.
    _admission_check: Callable[[int | None, Logger], None] | None = None

    def bind_admission_check(
        self, check: Callable[[int | None, Logger], None]
    ) -> None:
        """
        Wires this provider to the registry's capacity gate

        Args:
            check   - Callable a session invokes the moment it discovers
                        which worker (if any) its job landed on. Raises
                        TranscriptionCapacityError if that worker has no
                        room; a no-op call is always safe.

        Called once, by TranscriptionProviderRegistry._load_providers,
        immediately after construction - never by a session, and never
        more than once per provider.
        """
        self._admission_check = check

    def check_admission(self, worker_id: int | None, logger: Logger) -> None:
        """
        Asks the registry whether the given worker has room for one more
        session, raising TranscriptionCapacityError if not

        Args:
            worker_id   - The worker a session's job just landed on, or None
                            if this session's cost is not a capacity claim
                            (see TranscriptionSessionInterface.admission_worker_id)
            logger      - Logger to attach to a refusal

        A session calls this itself, right after registering its job - not
        the registry, and not at session construction - and calls it through
        `TranscriptionSessionInterface._admit_registered_job`, which owns the
        deregistration a refusal has to undo. Registration is what
        makes a session a claim on worker capacity at all (an idle,
        audio-less connection that never registers a job never shows up in
        any worker's live_job_count), so there is nothing to decide before
        it happens, and deciding any later would let that session's job sit
        on a worker it was never granted.
        """
        if self._admission_check is None:
            return
        self._admission_check(worker_id, logger)

    @property
    def job_period_ms(self) -> int | None:
        """
        Gets the period this provider registers its jobs with, if it can state
        one

        Reported on `/metrics/status` so the monitoring sidecar stops having to
        be told the same number in its own environment - the value lives in
        this service's provider_config.json, and while it was stated in two
        files by two people the sidecar's period-utilization series was
        silently misscaled whenever they disagreed.

        Concrete and defaulting to None rather than abstract, for the same
        reason as `describe_health` above: a provider added later must not fail
        to construct because it did not answer a telemetry question. None means
        "no period to state", which the sidecar treats as no reading at all
        rather than substituting a default - a plausible-looking utilization
        derived from the wrong period is a number an operator will act on.

        An override must return the value it actually passes to `register_job`,
        not a re-derivation of it. There is no way to enforce that here, so
        implementations state the period once and read it in both places.
        """
        return None

    @property
    def device(self) -> str | None:
        """
        Gets the inference device this provider's context runs on, if it can
        state one

        Reported on `/metrics/status` as `providerDevice` so the monitoring
        sidecar can select per-device alert thresholds — the same
        reported-then-fallback shape as `job_period_ms`. The duty-ratio
        threshold that fires on a healthy GPU (0.45) sits exactly on a healthy
        CPU value (0.471 with `small`), so one global number cannot serve both
        and every CPU deployment had to discover the override for itself.

        Concrete and defaulting to None rather than abstract: a provider that
        runs no local inference (`debug`, `lumen_granite`'s remote HTTP API)
        has no device to state, and None means "omitted from the map" rather
        than guessed at — the sidecar falls back to the GPU default for a
        provider with no reported device, which is the existing behaviour.

        The value is the device string the context was configured with
        (`"cuda"` or `"cpu"`), not an environment probe: it is what the
        deployment chose, which is what the alert threshold should match.
        """
        return None

    @property
    def context_tags(self) -> list[str]:
        """
        Gets the context tags this provider references, for registry-assisted
        resolution of cross-context properties like ``device``

        A provider like whisper-streaming references a context by tag but does
        not own the context's config, so properties that live on the context
        (such as inference device) cannot be returned from the provider's own
        ``device`` property. The registry builds a tag-to-device map during
        context loading and uses this property to look each provider's tags up
        in it, without having to know any concrete provider's config shape.

        Defaults to an empty list: a provider that references no contexts
        (``debug``, ``lumen_granite``) contributes nothing to the device map,
        which is the same as a provider whose ``device`` returns ``None``.
        """
        return []

    @property
    def active_sessions(self) -> int:
        """
        Gets the number of sessions currently open against this provider

        Providers did not track this before B1.7, so "which backend are these
        rooms actually using" had no answer.
        """
        return self._active_sessions

    def session_started(self) -> None:
        """
        Counts one session opened against this provider

        Called by the provider's own session, at the END of its __init__ - a
        session whose construction raises never opened, and counting it up
        front would leak a count that nothing ever decrements.
        """
        self._active_sessions += 1

    def session_ended(self) -> None:
        """
        Counts one session closed against this provider

        Clamped at zero so that a double end_session can only ever undercount.
        An unsigned drift understates load, which is a mild reporting error; a
        negative count is a visibly broken dashboard.
        """
        self._active_sessions = max(0, self._active_sessions - 1)

    async def describe_health(self) -> ProviderHealth:
        """
        Gets this provider's current health

        Default: alive but opaque. Providers override to add the signals only
        they can produce - context-load state for local models, endpoint
        reachability for remote ones.

        Returns:
            ProviderHealth snapshot
        """
        return ProviderHealth(
            kind=ProviderKind.DEBUG,
            status=ProviderStatus.OK,
            active_sessions=self._active_sessions,
        )
