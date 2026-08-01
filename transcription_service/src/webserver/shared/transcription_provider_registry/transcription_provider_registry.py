"""
Defines TranscriptionProviderRegistry that initializes and manages
transcription providers configured for the service.
"""

# pylint: disable=import-outside-toplevel
# Only import providers based on configuration
from dataclasses import dataclass
from typing import Any, Callable

from src.shared.config import (
    Config,
    JobContextConfigSchema,
    JobContextDefinitionUID,
    TranscriptionProviderConfigSchema,
    TranscriptionProviderUID,
)
from src.shared.logger import Logger
from src.shared.utils.worker_pool import (
    CapacityEstimator,
    ContextAssignment,
    JobObserver,
    WorkerPool,
    WorkerSnapshot,
)
from src.transcription_provider_interface import (
    AT_CAPACITY_REASON,
    ProviderHealth,
    ProviderKind,
    ProviderStatus,
    TranscriptionCapacityError,
    TranscriptionClientError,
    TranscriptionProviderInterface,
    TranscriptionSessionInterface,
)
from src.webserver.shared.metrics import MetricsRegistry


@dataclass(frozen=True)
class ProviderHealthEntry:
    """
    One provider's health, tagged with the identity it was configured under

    `provider_key` is the free-text key clients name in the stream URL;
    `provider_uid` is the implementation behind it. Both are reported because
    an operator debugging the "invalid provider key" failure needs to see the
    keys that *do* exist, while one debugging a model failure needs to know
    which implementation is misbehaving.
    """

    provider_key: str
    provider_uid: str | None
    health: ProviderHealth


@dataclass(frozen=True)
class ProvidersHealthReport:
    """
    Process-wide provider health, the body behind GET /providers/health
    """

    providers: list[ProviderHealthEntry]
    workers: list[WorkerSnapshot]
    num_workers: int
    invalid_provider_key_rejects: int


class TranscriptionProviderRegistry:
    """
    Owns the worker pool plus every configured transcription provider and
    hands out sessions on demand. Process-singleton across the service - the
    per-connection `TranscriptionStreamService` consults this registry to
    build a session for the requested provider key.
    """

    def __init__(
        self,
        config: Config,
        logger: Logger,
        job_observer: JobObserver | None = None,
        capacity_estimator: CapacityEstimator | None = None,
        metrics_registry: MetricsRegistry | None = None,
    ):
        """
        Args:
            config              - Application config
            logger              - Application logger
            job_observer        - Optional callback invoked for every completed
                                    job execution, used to feed the metrics
                                    registry
            capacity_estimator  - Optional per-worker capacity estimator
                                    (archived-plans/2026-07-27-02-PLAN-AdmissionControl.md
                                    §3). When absent, every session is admitted
                                    - the same behaviour as before admission
                                    control existed, which is what keeps every
                                    existing test and every embedding of this
                                    class that does not care about capacity
                                    working unchanged.
            metrics_registry    - Optional telemetry store, used only to count
                                    capacity refusals. Optional for the same
                                    reason: a refusal that cannot be counted is
                                    still a correct refusal, and making the
                                    counter mandatory would make admission
                                    control impossible to construct without the
                                    whole metrics stack.
        """
        self._capacity_estimator = capacity_estimator
        self._metrics_registry = metrics_registry

        contexts = self._load_contexts(config.provider_config.contexts)

        self._worker_pool = WorkerPool(
            logger,
            config.provider_config.num_workers,
            contexts,
            job_observer=job_observer,
        )

        # Everything past the pool's construction runs under a release guard,
        # because the pool has already spawned OS processes by this point and a
        # constructor that raises hands the caller no object to call
        # `shutdown()` on. `_load_providers` imports provider modules, so it
        # raises on any missing optional dependency - `import torch` for the
        # whisper provider is the one that actually happens - and without this
        # the pool's workers are left running, unreferenced and unstoppable.
        #
        # Observed as: `create_webserver` raising inside a test fixture's
        # `with TestClient(...)` expression, so the context manager is never
        # entered, the lifespan never runs, and the `shutdown()` in it never
        # fires. Thirteen such failures left thirteen unowned pools and pytest
        # could not exit.
        try:
            self._providers = self._load_providers(
                logger, self._worker_pool, config.provider_config.providers
            )
        except BaseException:
            self._worker_pool.shutdown()
            raise

        self._provider_uids: dict[str, str] = {
            key: provider.provider_uid
            for key, provider in config.provider_config.providers.items()
        }

        # Counts the failure mode that is otherwise invisible from the server
        # side: `transcriptionProviderId` is free text, so a typo closes the
        # websocket with a bare 1007 and looks to the client like the service
        # is broken. A rising count here names the cause.
        self._invalid_provider_key_rejects = 0

    def _load_contexts(
        self, context_configurations: list[JobContextConfigSchema]
    ) -> list[ContextAssignment]:
        """
        Build ContextAssignment list from the configured context entries

        Args:
            context_configurations  - List of context configurations to load

        Returns
            List of ContextAssignments preserving the order of the config
        """
        assignments: list[ContextAssignment] = []
        for config in context_configurations:
            match config.context_uid:
                case JobContextDefinitionUID.FASTER_WHISPER:
                    from src.transcription_contexts.faster_whisper_context import (
                        FasterWhisperContext,
                    )

                    context: Any = FasterWhisperContext(
                        config.context_config, config.tags
                    )
                case JobContextDefinitionUID.SILERO_VAD:
                    from src.transcription_contexts.silero_vad_context import (
                        SileroVadContext,
                    )

                    context = SileroVadContext(
                        config.context_config, config.tags
                    )

            assignments.append(
                ContextAssignment(
                    context_def=context, worker_ids=config.worker_ids
                )
            )
        return assignments

    def _load_providers(
        self,
        logger: Logger,
        worker_pool: WorkerPool,
        configured_providers: dict[str, TranscriptionProviderConfigSchema],
    ):
        """
        Imports transcription providers for all of the configured providers

        Args:
            logger                  - Logger to provide to providers
            worker_pool             - Worker pool to provide to providers
            configured_providers    - Mapping from provider_key to provider config

        Returns
            Provider instance dictionary
        """
        providers: dict[str, TranscriptionProviderInterface] = {}
        for provider_key, config in configured_providers.items():
            child_logger = logger.child({"provider_key": provider_key})

            match config.provider_uid:
                case TranscriptionProviderUID.DEBUG:
                    from src.transcription_providers.debug_provider import (
                        DebugProvider,
                    )

                    provider = DebugProvider(
                        config.provider_config,
                        child_logger,
                        worker_pool,
                        provider_key,
                    )
                case TranscriptionProviderUID.WHISPER_STREAMING:
                    from src.transcription_providers.whisper_streaming_provider import (
                        WhisperStreamingProvider,
                    )

                    provider = WhisperStreamingProvider(
                        config.provider_config,
                        child_logger,
                        worker_pool,
                        provider_key,
                    )
                case TranscriptionProviderUID.LUMEN_GRANITE:
                    from src.transcription_providers.lumen_granite_provider import (
                        LumenGraniteProvider,
                    )

                    provider = LumenGraniteProvider(
                        config.provider_config,
                        child_logger,
                        worker_pool,
                        provider_key,
                    )

            # Bound per provider_key rather than shared, so a refusal is
            # always counted and logged against the provider whose session
            # actually triggered it, not whichever provider happened to be
            # loaded last.
            provider.bind_admission_check(
                self._make_admission_check(provider_key)
            )
            providers[provider_key] = provider
        return providers

    @property
    def num_workers(self) -> int:
        """
        Gets number of worker processes the pool was configured with

        The deployed value of this has been an open question for the capacity
        model; reporting it is how it stops being one.
        """
        return self._worker_pool.num_workers

    @property
    def provider_keys(self) -> list[str]:
        """
        Gets the configured provider keys, in config order
        """
        return list(self._providers.keys())

    @property
    def provider_job_period_ms(self) -> dict[str, int]:
        """
        Gets the job period each provider schedules with, keyed by provider key

        A provider that cannot state one is **absent from the map** rather than
        present with a placeholder: the consumer (the monitoring sidecar) uses
        the presence of a period to decide whether to publish a ratio derived
        from it, and "no reading" is not the same claim as a guessed one.

        Side effect free, so it is safe to call from a request handler.
        """
        periods: dict[str, int] = {}
        for key, provider in self._providers.items():
            period_ms = provider.job_period_ms
            if period_ms is not None:
                periods[key] = period_ms
        return periods

    def worker_snapshots(self) -> list[WorkerSnapshot]:
        """
        Gets a point-in-time view of every worker's load

        Side effect free, so it is safe to call from a request handler.
        """
        return self._worker_pool.worker_snapshots()

    async def providers_health(self) -> ProvidersHealthReport:
        """
        Gets the health of every configured provider, plus pool-wide context

        Side effect free with respect to transcription: local providers read
        in-memory state only and remote providers answer from a cached probe.

        A provider whose own health check raises is reported as down with the
        error as its detail, rather than being allowed to fail the whole
        response - one sick provider must not blind the operator to the other
        five, which is exactly when they would need the page most.
        """
        entries: list[ProviderHealthEntry] = []
        for provider_key, provider in self._providers.items():
            try:
                health = await provider.describe_health()
            # pylint: disable=broad-exception-caught
            except Exception as error:
                health = ProviderHealth(
                    kind=ProviderKind.UNKNOWN,
                    status=ProviderStatus.DOWN,
                    active_sessions=0,
                    detail=(
                        "health check failed: "
                        f"{type(error).__name__}: {error}"
                    ),
                )
            entries.append(
                ProviderHealthEntry(
                    provider_key=provider_key,
                    provider_uid=self._provider_uids.get(provider_key),
                    health=health,
                )
            )

        return ProvidersHealthReport(
            providers=entries,
            workers=self._worker_pool.worker_snapshots(),
            num_workers=self._worker_pool.num_workers,
            invalid_provider_key_rejects=self._invalid_provider_key_rejects,
        )

    def create_session(
        self,
        provider_key: str,
        session_config: Any,
        session_uid: str | None,
        room_uid: str | None,
        logger: Logger,
    ) -> TranscriptionSessionInterface:
        """
        Gets the initialized transcription provider instance with the given
        provider key and creates a session

        Args:
            provider_key    - Transcription Provider key of provider to get
            session_config  - Session configuration provided by client
            session_uid     - Opaque session identifier from the caller, if
                                known
            room_uid        - Opaque room identifier from the caller, if known
            logger          - Application logger for session to use

        Returns:
            TranscriptionSessionInterface of selected transcription provider

        Raises:
            TranscriptionClientError if provider doesn't exist

        NEVER RAISES TranscriptionCapacityError. That used to be decided here,
        synchronously, because a session's job registered as part of its own
        construction - so by the time this returned, it had already taken a
        worker's job slot whether or not the caller ever sent it any audio.
        That is exactly the failure this method used to cause: an idle,
        audio-less connection occupied capacity identically to a real one, so
        opening enough of them could refuse a genuinely busy worker's actual
        next session, or - worse - refuse each other, entirely independent of
        real transcription load.

        Registration is deferred to a session's own first `handle_audio_chunk`
        (see each provider's `_ensure_job`), which is also now where admission
        is decided - a session calls `provider.check_admission(...)` itself,
        right after registering, via the callback `_make_admission_check`
        binds onto its provider at load time. A refusal therefore surfaces
        from `handle_audio_chunk`, not from here, and propagates out through
        `TranscriptionStreamService.handle_audio_chunk` exactly like any other
        session error - no special plumbing needed, since Python exceptions
        already cross that boundary uncaught.
        """
        if provider_key not in self._providers:
            self._invalid_provider_key_rejects += 1
            raise TranscriptionClientError("Invalid Provider Key")

        provider = self._providers[provider_key]
        return provider.create_session(
            session_config, session_uid, room_uid, logger
        )

    def _make_admission_check(
        self, provider_key: str
    ) -> Callable[[int | None, Logger], None]:
        """
        Builds the admission callback one provider is bound to at load time

        Args:
            provider_key    - The provider this callback decides for, closed
                                over so a refusal is always counted and logged
                                against the provider whose session actually
                                registered the job, not whichever provider
                                `_load_providers` happened to construct last

        Returns:
            A callable a session invokes with the worker its job just landed
            on (or None - see TranscriptionSessionInterface.admission_worker_id).
            Raises TranscriptionCapacityError if that worker has no room;
            otherwise returns normally.

        Every gate here fails open, which is this plan's stated posture rather
        than laziness: an over-admission is visible, counted and self-corrects,
        while a wrong refusal is invisible and unrecoverable for that user.
        Four of them are reached in normal operation:

        1. `worker_id is None` - the session is not a claim on a local worker's
           ASR throughput (`lumen_granite`, `debug`), or it has not yet
           registered a job at all. See
           TranscriptionSessionInterface.admission_worker_id for why both are
           the same statement.
        2. No estimator configured - admission control is not wired up.
        3. The pool reports no such worker. A worker that vanished between
           registration and this read is a pool fault, not a capacity fault,
           and refusing the user for it would misattribute the outage.

        CONCURRENCY. The session calls this synchronously, immediately after
        `register_job` returns and before any `await` - register, read, decide
        and (if refused) deregister all run on the one event loop thread the
        pool's registration bookkeeping also runs on. Two sessions registering
        together are therefore serialized, and each sees the other's
        registration reflected in `live_job_count` only if that registration
        actually happened first. There is no window in which both read a
        pre-registration count and both get admitted, nor one in which both
        count the other and both get refused.

        The `- 1` is what makes that true. `admit()` is specified as
        `N == 0 or N + 1 <= N*` where N is the count *before* placing the new
        session, but by the time this runs the session is already registered
        and the pool's `live_job_count` includes it. Passing that count raw
        would ask whether an N+2nd session fits and would refuse the first
        session on an idle worker, since N would never read as 0.

        TWO KNOWN LIMITATIONS, NAMED RATHER THAN GUARDED:

        - A refusal is final for the *worker the pool chose*, and there is no
          retry onto a different one. With `num_workers > 1`, routing picks by
          rolling utilization, which a just-registered job has not yet moved -
          so two sessions arriving back to back can both be routed to the same
          worker and the second refused while another worker had room. Both
          shipped provider_config templates set `num_workers: 1`, where this is
          inert, and re-placement is a routing change nobody has asked for; it
          becomes real the moment a deployment raises the worker count.
        - `lumen_granite` sessions are never refused, but they are not free
          either: their job holds the worker's single job slot for the duration
          of a blocking upstream HTTP request, so they raise the measured busy
          fraction and can therefore tighten the ceiling applied to whisper
          sessions sharing that worker. Excluding them from *being* refused is
          §5's deferral of remote-provider capacity; it is not a claim that they
          cost a worker nothing.
        """

        def _check(worker_id: int | None, logger: Logger) -> None:
            if self._admits_worker(worker_id):
                return

            if self._metrics_registry is not None:
                self._metrics_registry.record_capacity_refusal(provider_key)
            logger.warning(
                "Refused session: worker at capacity",
                context={"provider_key": provider_key, "worker_id": worker_id},
            )
            raise TranscriptionCapacityError(AT_CAPACITY_REASON)

        return _check

    def _admits_worker(self, worker_id: int | None) -> bool:
        """
        Whether one more job may keep the worker slot it just took

        Args:
            worker_id   - The worker a session's job just registered onto, or
                            None if this session's cost is not a capacity claim

        Returns:
            True if the session should be allowed to proceed
        """
        if worker_id is None:
            return True

        if self._capacity_estimator is None:
            return True

        live_job_count = self._live_job_count(worker_id)
        if live_job_count is None:
            return True

        return self._capacity_estimator.admit(
            worker_id, max(0, live_job_count - 1)
        )

    def _live_job_count(self, worker_id: int) -> int | None:
        """
        Gets one worker's live job count, or None if the pool has no such worker

        Args:
            worker_id   - Worker to look up

        Returns:
            Jobs currently registered to that worker, None if it is not in the
            pool's snapshot

        Read from the pool's own snapshot rather than tracked here, for the
        reason CapacityEstimator.snapshot() gives for taking N as an argument:
        WorkerSnapshot.live_job_count is the robust source, and a second copy
        would eventually disagree with the first.
        """
        for snapshot in self._worker_pool.worker_snapshots():
            if snapshot.worker_id == worker_id:
                return snapshot.live_job_count
        return None

    def shutdown(self):
        """
        Cleans up all initialized providers
        """
        for _, provider in self._providers.items():
            provider.cleanup_provider()

        self._worker_pool.shutdown()
