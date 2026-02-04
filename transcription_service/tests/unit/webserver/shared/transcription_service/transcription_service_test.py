"""
Unit tests for TranscriptionService
"""

from unittest.mock import MagicMock, call

import pytest
from pytest_mock import MockerFixture, MockType

from src.shared.config import (
    Config,
    JobContextConfigSchema,
    JobContextDefinitionUID,
    ProviderConfigFileSchema,
    TranscriptionProviderConfigSchema,
    TranscriptionProviderUID,
)
from src.shared.logger import Logger
from src.shared.utils.worker_pool import JobContextInterface, WorkerPool
from src.transcription_provider_interface import (
    TranscriptionClientError,
    TranscriptionProviderInterface,
)
from src.webserver.shared.transcription_service import TranscriptionService

NUM_WORKERS = 2
ROLLING_UTILIZATION_WINDOW_SEC = 5


@pytest.fixture
def mock_config():
    """
    Pytest fixture to create a mock config object for tests.
    """
    mock = MagicMock(spec=Config)

    context_configs: list[JobContextConfigSchema] = [
        JobContextConfigSchema(
            context_uid=JobContextDefinitionUID.FASTER_WHISPER,
            max_instances=1,
            tags=["tag0", "tag1"],
            negative_affinity=None,
            context_config="config:faster_0",
            creation_cost=0.1,
        ),
        JobContextConfigSchema(
            context_uid=JobContextDefinitionUID.FASTER_WHISPER,
            max_instances=2,
            tags=["tag1"],
            negative_affinity="tag0",
            context_config="config:faster_1",
            creation_cost=0,
        ),
    ]

    provider_configs: list[TranscriptionProviderConfigSchema] = [
        TranscriptionProviderConfigSchema(
            provider_key="debug_0",
            provider_uid=TranscriptionProviderUID.DEBUG,
            provider_config="config:debug_0",
        ),
        TranscriptionProviderConfigSchema(
            provider_key="debug_1",
            provider_uid=TranscriptionProviderUID.DEBUG,
            provider_config="config:debug_1",
        ),
    ]

    mock.provider_config = ProviderConfigFileSchema(
        num_workers=NUM_WORKERS,
        rolling_utilization_window_sec=ROLLING_UTILIZATION_WINDOW_SEC,
        contexts=context_configs,
        providers=provider_configs,
    )
    return mock


@pytest.fixture
def mock_logger():
    """
    Create a mocked logger instance for tests
    """
    mock = MagicMock(spec=Logger)
    mock.child.return_value = mock
    return mock


@pytest.fixture
def mock_context_instances(mocker: MockerFixture):
    """
    Mock instances for all contexts
    """
    return [
        mocker.MagicMock(spec=JobContextInterface),
        mocker.MagicMock(spec=JobContextInterface),
    ]


@pytest.fixture
def mock_context_import(
    mocker: MockerFixture, mock_context_instances: list[MagicMock]
) -> dict[JobContextDefinitionUID, MockType]:
    """
    Patches imports for job contexts
    """
    mock = mocker.MagicMock()
    mock.FasterWhisperContext = mocker.MagicMock(
        side_effect=[mock_context_instances[0], mock_context_instances[1]]
    )

    # Patch sys.modules to inject our mock
    mocker.patch.dict(
        "sys.modules",
        {"src.transcription_contexts.faster_whisper_context": mock},
    )

    return {JobContextDefinitionUID.FASTER_WHISPER: mock.FasterWhisperContext}


@pytest.fixture
def mock_worker_pool_instance(mocker: MockerFixture):
    """
    Mock instance for worker pool
    """
    return mocker.MagicMock(spec=WorkerPool)


@pytest.fixture
def mock_worker_pool_import(
    mocker: MockerFixture, mock_worker_pool_instance: MagicMock
):
    """
    Mock worker pool
    """
    return mocker.patch(
        "src.webserver.shared.transcription_service.transcription_service.WorkerPool",
        return_value=mock_worker_pool_instance,
    )


@pytest.fixture
def mock_provider_instances(mocker: MockerFixture):
    """
    Patches import for worker pool
    """
    return [
        mocker.MagicMock(spec=TranscriptionProviderInterface),
        mocker.MagicMock(spec=TranscriptionProviderInterface),
    ]


@pytest.fixture
def mock_provider_import(
    mocker: MockerFixture, mock_provider_instances: list[MagicMock]
) -> dict[TranscriptionProviderUID, MockType]:
    """
    Patches imports for providers
    """
    # For dynamic imports, we need to mock the module before it's imported
    mock_debug_module = mocker.MagicMock()
    mock_debug_module.DebugProvider = mocker.MagicMock(
        side_effect=[mock_provider_instances[0], mock_provider_instances[1]]
    )

    # Patch sys.modules to inject our mock
    mocker.patch.dict(
        "sys.modules",
        {"src.transcription_providers.debug_provider": mock_debug_module},
    )

    return {TranscriptionProviderUID.DEBUG: mock_debug_module.DebugProvider}


# pylint: disable=unused-argument
@pytest.fixture
def transcription_service(
    mock_config: Config,
    mock_logger: Logger,
    mock_worker_pool_import: MagicMock,
    mock_context_import: MockType,
    mock_provider_import: MockType,
):
    """
    Create a fresh transcription service for each test
    """
    return TranscriptionService(mock_config, mock_logger)


# pylint: disable=unused-argument
def test_loads_context(
    mock_config: Config,
    mock_context_import: MockType,
    transcription_service: TranscriptionService,
):
    """
    Test that transcription service imports job context with correct config
    """
    # Arrange / Act / Assert
    mock_context_import[
        JobContextDefinitionUID.FASTER_WHISPER
    ].assert_has_calls(
        [
            call(
                mock_config.provider_config.contexts[0].context_config,
                mock_config.provider_config.contexts[0].max_instances,
                mock_config.provider_config.contexts[0].tags,
                mock_config.provider_config.contexts[0].negative_affinity,
                mock_config.provider_config.contexts[0].creation_cost,
            ),
            call(
                mock_config.provider_config.contexts[1].context_config,
                mock_config.provider_config.contexts[1].max_instances,
                mock_config.provider_config.contexts[1].tags,
                mock_config.provider_config.contexts[1].negative_affinity,
                mock_config.provider_config.contexts[1].creation_cost,
            ),
        ]
    )


# pylint: disable=unused-argument
def test_creates_worker_pool(
    mock_logger: Logger,
    mock_worker_pool_import: MagicMock,
    mock_context_instances: list[MagicMock],
    transcription_service: TranscriptionService,
):
    """
    Test that transcription service creates worker pool with correct config
    """
    # Arrange / Acts
    context_def = {0: mock_context_instances[0], 1: mock_context_instances[1]}

    # Assert
    mock_worker_pool_import.assert_called_once_with(
        mock_logger, NUM_WORKERS, context_def, ROLLING_UTILIZATION_WINDOW_SEC
    )


# pylint: disable=unused-argument
def test_loads_provider(
    mock_config: Config,
    mock_logger: Logger,
    mock_worker_pool_instance: MagicMock,
    mock_provider_import: MockType,
    transcription_service: TranscriptionService,
):
    """
    Test that transcription service imports providers with correct config
    """
    # Arrange / Act / Assert
    mock_provider_import[TranscriptionProviderUID.DEBUG].assert_has_calls(
        [
            call(
                mock_config.provider_config.providers[0].provider_config,
                mock_logger,
                mock_worker_pool_instance,
            ),
            call(
                mock_config.provider_config.providers[1].provider_config,
                mock_logger,
                mock_worker_pool_instance,
            ),
        ]
    )


@pytest.mark.parametrize(
    "provider_key, mock_provider_idx", [("debug_0", 0), ("debug_1", 1)]
)
def test_valid_start_session(
    transcription_service: TranscriptionService,
    provider_key: str,
    mock_provider_idx: int,
    mock_provider_instances: list[MagicMock],
):
    """
    Test transcription service starts correct session with valid provider key
    """
    # Arrange
    config = "some_config"
    session_logger = MagicMock(spec=Logger)

    # Act
    _ = transcription_service.create_session(
        provider_key, config, session_logger
    )

    # Assert
    mock_provider_instances[
        mock_provider_idx
    ].create_session.assert_called_once_with(config, session_logger)


def test_invalid_start_session(transcription_service: TranscriptionService):
    """
    Test transcription service throws TranscriptionClientError when
        starting session with invalid provider UID
    """
    # Arrange
    config = "some_config"
    session_logger = MagicMock(spec=Logger)

    # Act / Assert
    with pytest.raises(TranscriptionClientError):
        _ = transcription_service.create_session(
            "NOT_A_REAL_PROVIDER", config, session_logger
        )


def test_shutdown_cleans_up_resources(
    transcription_service: TranscriptionService,
    mock_provider_instances: list[MagicMock],
    mock_worker_pool_instance: MagicMock,
):
    """
    Test transcription service shutdown cleans up providers and shuts down worker pool
    """
    # Arrange / Act
    transcription_service.shutdown()

    # Assert
    for instance in mock_provider_instances:
        instance.cleanup_provider.assert_called_once()
    mock_worker_pool_instance.shutdown.assert_called_once()
