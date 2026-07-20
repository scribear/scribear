"""
Defines TranscriptionProviderRegistry that initializes and manages
transcription providers configured for the service.
"""

# pylint: disable=import-outside-toplevel
# Only import providers based on configuration
from dataclasses import dataclass
from typing import Any

from src.shared.config import (
    Config,
    JobContextConfigSchema,
    JobContextDefinitionUID,
    TranscriptionProviderConfigSchema,
    TranscriptionProviderUID,
)
from src.shared.logger import Logger
from src.shared.utils.worker_pool import (
    ContextAssignment,
    JobObserver,
    WorkerPool,
    WorkerSnapshot,
)
from src.transcription_provider_interface import (
    ProviderHealth,
    ProviderKind,
    ProviderStatus,
    TranscriptionClientError,
    TranscriptionProviderInterface,
    TranscriptionSessionInterface,
)


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
    ):
        """
        Args:
            config          - Application config
            logger          - Application logger
            job_observer    - Optional callback invoked for every completed job
                                execution, used to feed the metrics registry
        """
        contexts = self._load_contexts(config.provider_config.contexts)

        self._worker_pool = WorkerPool(
            logger,
            config.provider_config.num_workers,
            contexts,
            job_observer=job_observer,
        )

        self._providers = self._load_providers(
            logger, self._worker_pool, config.provider_config.providers
        )

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
        self, provider_key: str, session_config: Any, logger: Logger
    ) -> TranscriptionSessionInterface:
        """
        Gets the initialized transcription provider instance with the given
        provider key and creates a session

        Args:
            provider_key    - Transcription Provider key of provider to get
            session_config  - Session configuration provided by client
            logger          - Application logger for session to use

        Returns:
            TranscriptionSessionInterface of selected transcription provider

        Raises:
            TranscriptionClientError if provider doesn't exist
        """
        if provider_key not in self._providers:
            self._invalid_provider_key_rejects += 1
            raise TranscriptionClientError("Invalid Provider Key")

        provider = self._providers[provider_key]
        return provider.create_session(session_config, logger)

    def shutdown(self):
        """
        Cleans up all initialized providers
        """
        for _, provider in self._providers.items():
            provider.cleanup_provider()

        self._worker_pool.shutdown()
