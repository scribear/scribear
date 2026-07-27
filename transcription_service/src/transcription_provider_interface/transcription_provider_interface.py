"""
Defines TranscriptionProviderInterface API for transcription providers
"""

from abc import ABC, abstractmethod

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
