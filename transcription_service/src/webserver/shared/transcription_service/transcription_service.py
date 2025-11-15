"""
Defines ProviderManager that initializes and manages transcription providers
"""

# pylint: disable=import-outside-toplevel
# Only import providers based on configuration
from typing import Any

from src.shared.config import (
    Config,
    JobContextConfigSchema,
    JobContextDefinitionUID,
    TranscriptionProviderConfigSchema,
    TranscriptionProviderUID,
)
from src.shared.logger import Logger
from src.shared.utils.worker_pool import JobContextInterface, WorkerPool
from src.transcription_provider_interface import (
    TranscriptionClientError,
    TranscriptionProviderInterface,
    TranscriptionSessionInterface,
)


class TranscriptionService:
    """
    Manages initializing transcription providers and holding created transcription providers
    """

    def __init__(self, config: Config, logger: Logger):
        """
        Args:
            config      - Application config
            logger      - Application logger
        """
        context_def = self._load_context_def(config.provider_config.contexts)

        self._worker_pool = WorkerPool(
            logger,
            config.provider_config.num_workers,
            context_def,
            config.provider_config.rolling_utilization_window_sec,
        )

        self._providers = self._load_providers(
            logger, self._worker_pool, config.provider_config.providers
        )

    def _load_context_def(
        self, context_configurations: list[JobContextConfigSchema]
    ):
        """
        Imports definitions for all of the configured context definitions

        Args:
            context_configurations  - List of context configurations to load

        Returns
            Context definition dictionary for WorkerPool to use
        """
        context_def: dict[int, JobContextInterface[Any]] = {}
        for i, config in enumerate(context_configurations):
            match config.context_uid:
                case JobContextDefinitionUID.FASTER_WHISPER:
                    from src.transcription_contexts.faster_whisper_context import (
                        FasterWhisperContext,
                    )

                    context = FasterWhisperContext(
                        config.context_config,
                        config.max_instances,
                        config.tags,
                        config.negative_affinity,
                        config.creation_cost,
                    )

            context_def[i] = context
        return context_def

    def _load_providers(
        self,
        logger: Logger,
        worker_pool: WorkerPool,
        configured_providers: list[TranscriptionProviderConfigSchema],
    ):
        """
        Imports transcription providers for all of the configured providers

        Args:
            logger                  - Logger to provide to providers
            worker_pool             - Worker pool to provide to providers
            configured_providers    - List of provider configurations to load

        Returns
            Provider instance dictionary
        """
        providers: dict[str, TranscriptionProviderInterface] = {}
        for config in configured_providers:
            child_logger = logger.child({"provider_key": config.provider_key})

            match config.provider_uid:
                case TranscriptionProviderUID.DEBUG:
                    from src.transcription_providers.debug_provider import (
                        DebugProvider,
                    )

                    provider = DebugProvider(
                        config.provider_config, child_logger, worker_pool
                    )
                case TranscriptionProviderUID.WHISPER_STREAMING:
                    from src.transcription_providers.whisper_streaming_provider import (
                        WhisperStreamingProvider,
                    )

                    provider = WhisperStreamingProvider(
                        config.provider_config, child_logger, worker_pool
                    )

            providers[config.provider_key] = provider
        return providers

    def create_session(
        self, provider_key: str, session_config: Any, logger: Logger
    ) -> TranscriptionSessionInterface:
        """
        Gets the initialized transcription provider instance with the given provider uid and
            creates a session

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
