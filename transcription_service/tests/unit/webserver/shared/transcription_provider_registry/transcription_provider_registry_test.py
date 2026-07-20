"""
Unit tests for TranscriptionProviderRegistry
"""

from unittest.mock import AsyncMock, MagicMock, call

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
from src.shared.utils.worker_pool import (
    ContextAssignment,
    JobContextInterface,
    WorkerPool,
)
from src.transcription_provider_interface import (
    ProviderHealth,
    ProviderKind,
    ProviderStatus,
    TranscriptionClientError,
    TranscriptionProviderInterface,
)
from src.webserver.shared.transcription_provider_registry import (
    TranscriptionProviderRegistry,
)

NUM_WORKERS = 2


@pytest.fixture
def mock_config():
    """
    Pytest fixture to create a mock config object for tests.
    """
    mock = MagicMock(spec=Config)

    context_configs: list[JobContextConfigSchema] = [
        JobContextConfigSchema(
            context_uid=JobContextDefinitionUID.FASTER_WHISPER,
            worker_ids=[0],
            tags=["tag0", "tag1"],
            context_config="config:faster_0",
        ),
        JobContextConfigSchema(
            context_uid=JobContextDefinitionUID.FASTER_WHISPER,
            worker_ids=[0, 1],
            tags=["tag1"],
            context_config="config:faster_1",
        ),
    ]

    provider_configs: dict[str, TranscriptionProviderConfigSchema] = {
        "debug_0": TranscriptionProviderConfigSchema(
            provider_uid=TranscriptionProviderUID.DEBUG,
            provider_config="config:debug_0",
        ),
        "debug_1": TranscriptionProviderConfigSchema(
            provider_uid=TranscriptionProviderUID.DEBUG,
            provider_config="config:debug_1",
        ),
    }

    mock.provider_config = ProviderConfigFileSchema(
        num_workers=NUM_WORKERS,
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
        "src.webserver.shared.transcription_provider_registry"
        ".transcription_provider_registry.WorkerPool",
        return_value=mock_worker_pool_instance,
    )


@pytest.fixture
def mock_provider_instances(mocker: MockerFixture):
    """
    Mock provider instances for the two debug providers
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
    mock_debug_module = mocker.MagicMock()
    mock_debug_module.DebugProvider = mocker.MagicMock(
        side_effect=[mock_provider_instances[0], mock_provider_instances[1]]
    )

    mocker.patch.dict(
        "sys.modules",
        {"src.transcription_providers.debug_provider": mock_debug_module},
    )

    return {TranscriptionProviderUID.DEBUG: mock_debug_module.DebugProvider}


# pylint: disable=unused-argument
@pytest.fixture
def provider_registry(
    mock_config: Config,
    mock_logger: Logger,
    mock_worker_pool_import: MagicMock,
    mock_context_import: MockType,
    mock_provider_import: MockType,
):
    """
    Create a fresh transcription service for each test
    """
    return TranscriptionProviderRegistry(mock_config, mock_logger)


# pylint: disable=unused-argument
def test_loads_context(
    mock_config: Config,
    mock_context_import: MockType,
    provider_registry: TranscriptionProviderRegistry,
):
    """
    Test that transcription service imports job context with correct config and tags
    """
    # Arrange / Act / Assert
    mock_context_import[
        JobContextDefinitionUID.FASTER_WHISPER
    ].assert_has_calls(
        [
            call(
                mock_config.provider_config.contexts[0].context_config,
                mock_config.provider_config.contexts[0].tags,
            ),
            call(
                mock_config.provider_config.contexts[1].context_config,
                mock_config.provider_config.contexts[1].tags,
            ),
        ]
    )


# pylint: disable=unused-argument
def test_creates_worker_pool(
    mock_config: Config,
    mock_logger: Logger,
    mock_worker_pool_import: MagicMock,
    mock_context_instances: list[MagicMock],
    provider_registry: TranscriptionProviderRegistry,
):
    """
    Test that transcription service creates worker pool with ContextAssignments
    built from each config entry and its worker_ids
    """
    # Arrange
    expected_assignments = [
        ContextAssignment(
            context_def=mock_context_instances[0],
            worker_ids=mock_config.provider_config.contexts[0].worker_ids,
        ),
        ContextAssignment(
            context_def=mock_context_instances[1],
            worker_ids=mock_config.provider_config.contexts[1].worker_ids,
        ),
    ]

    # Assert
    mock_worker_pool_import.assert_called_once_with(
        mock_logger, NUM_WORKERS, expected_assignments, job_observer=None
    )


# pylint: disable=unused-argument
def test_loads_provider(
    mock_config: Config,
    mock_logger: Logger,
    mock_worker_pool_instance: MagicMock,
    mock_provider_import: MockType,
    provider_registry: TranscriptionProviderRegistry,
):
    """
    Test that transcription service imports providers with correct config
    """
    # Arrange / Act / Assert
    mock_provider_import[TranscriptionProviderUID.DEBUG].assert_has_calls(
        [
            call(
                mock_config.provider_config.providers[
                    "debug_0"
                ].provider_config,
                mock_logger,
                mock_worker_pool_instance,
                "debug_0",
            ),
            call(
                mock_config.provider_config.providers[
                    "debug_1"
                ].provider_config,
                mock_logger,
                mock_worker_pool_instance,
                "debug_1",
            ),
        ]
    )


# pylint: disable=unused-argument
def test_passes_job_observer_to_worker_pool(
    mock_config: Config,
    mock_logger: Logger,
    mock_worker_pool_import: MagicMock,
    mock_context_import: MockType,
    mock_provider_import: MockType,
):
    """
    Test the metrics hook reaches the worker pool

    The observer is what turns job statistics from logged-and-discarded into
    something the status endpoint can report, so its wiring is worth pinning.
    """
    # Arrange
    observer = MagicMock()

    # Act
    TranscriptionProviderRegistry(mock_config, mock_logger, observer)

    # Assert
    assert mock_worker_pool_import.call_args.kwargs["job_observer"] is observer


# pylint: disable=unused-argument
def test_exposes_worker_load_without_private_access(
    mock_worker_pool_instance: MagicMock,
    provider_registry: TranscriptionProviderRegistry,
):
    """
    Test the registry surfaces pool capacity and per-worker load

    num_workers in particular is the deployed value the capacity model has
    been carrying as an open question.
    """
    # Arrange
    mock_worker_pool_instance.num_workers = 4
    snapshots = [MagicMock()]
    mock_worker_pool_instance.worker_snapshots.return_value = snapshots

    # Act / Assert
    assert provider_registry.num_workers == 4
    assert provider_registry.worker_snapshots() == snapshots
    assert provider_registry.provider_keys == ["debug_0", "debug_1"]


@pytest.mark.parametrize(
    "provider_key, mock_provider_idx", [("debug_0", 0), ("debug_1", 1)]
)
def test_valid_start_session(
    provider_registry: TranscriptionProviderRegistry,
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
    _ = provider_registry.create_session(provider_key, config, session_logger)

    # Assert
    mock_provider_instances[
        mock_provider_idx
    ].create_session.assert_called_once_with(config, session_logger)


def test_invalid_start_session(
    provider_registry: TranscriptionProviderRegistry,
):
    """
    Test transcription service throws TranscriptionClientError when
        starting session with invalid provider UID
    """
    # Arrange
    config = "some_config"
    session_logger = MagicMock(spec=Logger)

    # Act / Assert
    with pytest.raises(TranscriptionClientError):
        _ = provider_registry.create_session(
            "NOT_A_REAL_PROVIDER", config, session_logger
        )


def test_shutdown_cleans_up_resources(
    provider_registry: TranscriptionProviderRegistry,
    mock_provider_instances: list[MagicMock],
    mock_worker_pool_instance: MagicMock,
):
    """
    Test transcription service shutdown cleans up providers and shuts down worker pool
    """
    # Arrange / Act
    provider_registry.shutdown()

    # Assert
    for instance in mock_provider_instances:
        instance.cleanup_provider.assert_called_once()
    mock_worker_pool_instance.shutdown.assert_called_once()


@pytest.mark.asyncio
async def test_providers_health_reports_every_provider_with_its_uid(
    provider_registry: TranscriptionProviderRegistry,
    mock_provider_instances: list[MagicMock],
    mock_worker_pool_instance: MagicMock,
):
    """
    Test each configured provider is reported with the identity it was loaded
    under, alongside pool-wide context
    """
    # Arrange
    snapshots = [MagicMock()]
    mock_worker_pool_instance.num_workers = NUM_WORKERS
    mock_worker_pool_instance.worker_snapshots.return_value = snapshots
    for instance in mock_provider_instances:
        instance.describe_health = AsyncMock(
            return_value=ProviderHealth(
                kind=ProviderKind.DEBUG,
                status=ProviderStatus.OK,
                active_sessions=0,
            )
        )

    # Act
    report = await provider_registry.providers_health()

    # Assert
    assert [entry.provider_key for entry in report.providers] == [
        "debug_0",
        "debug_1",
    ]
    assert [entry.provider_uid for entry in report.providers] == [
        TranscriptionProviderUID.DEBUG,
        TranscriptionProviderUID.DEBUG,
    ]
    assert report.workers == snapshots
    assert report.num_workers == NUM_WORKERS


@pytest.mark.asyncio
async def test_providers_health_isolates_a_provider_that_raises(
    provider_registry: TranscriptionProviderRegistry,
    mock_provider_instances: list[MagicMock],
    mock_worker_pool_instance: MagicMock,
):
    """
    Test one provider's failing health check does not fail the whole response

    A sick provider must not blind the operator to the healthy ones - that is
    precisely the moment the page is being looked at.
    """
    # Arrange
    mock_worker_pool_instance.worker_snapshots.return_value = []
    mock_provider_instances[0].describe_health = AsyncMock(
        side_effect=RuntimeError("model handle is gone")
    )
    mock_provider_instances[1].describe_health = AsyncMock(
        return_value=ProviderHealth(
            kind=ProviderKind.DEBUG, status=ProviderStatus.OK, active_sessions=0
        )
    )

    # Act
    report = await provider_registry.providers_health()

    # Assert
    failed, healthy = report.providers
    assert failed.health.status == ProviderStatus.DOWN
    assert failed.health.kind == ProviderKind.UNKNOWN
    assert "model handle is gone" in (failed.health.detail or "")
    assert healthy.health.status == ProviderStatus.OK


@pytest.mark.asyncio
async def test_counts_invalid_provider_key_rejects(
    provider_registry: TranscriptionProviderRegistry,
    mock_worker_pool_instance: MagicMock,
):
    """
    Test a session opened against an unknown key increments the reject counter

    `transcriptionProviderId` is free text, so a typo closes the websocket with
    a bare 1007 that looks to the client like the service is broken. This
    counter is what names the cause.
    """
    # Arrange
    mock_worker_pool_instance.worker_snapshots.return_value = []
    session_logger = MagicMock(spec=Logger)

    # Act
    for _ in range(3):
        with pytest.raises(TranscriptionClientError):
            provider_registry.create_session(
                "NOT_A_REAL_PROVIDER", "config", session_logger
            )
    report = await provider_registry.providers_health()

    # Assert
    assert report.invalid_provider_key_rejects == 3


@pytest.mark.asyncio
async def test_valid_provider_key_does_not_count_as_a_reject(
    provider_registry: TranscriptionProviderRegistry,
    mock_worker_pool_instance: MagicMock,
):
    """
    Test opening a session against a configured key leaves the counter alone
    """
    # Arrange
    mock_worker_pool_instance.worker_snapshots.return_value = []
    session_logger = MagicMock(spec=Logger)

    # Act
    provider_registry.create_session("debug_0", "config", session_logger)
    report = await provider_registry.providers_health()

    # Assert
    assert report.invalid_provider_key_rejects == 0
