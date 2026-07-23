"""
Unit tests for WhisperStreamingProvider health reporting
"""

from unittest.mock import MagicMock

import pytest

from src.shared.logger import Logger
from src.shared.utils.worker_pool import WorkerPool, WorkerSnapshot
from src.transcription_provider_interface import ProviderKind, ProviderStatus
from src.transcription_providers.whisper_streaming_provider import (
    WhisperStreamingProvider,
)

WHISPER_TAG = "whisper_context"
SILERO_TAG = "silero_context"
PROVIDER_KEY = "whisper"

PROVIDER_CONFIG = {
    "whisper_context_tag": WHISPER_TAG,
    "silero_context_tag": SILERO_TAG,
    "job_period_ms": 1000,
    "max_buffer_len_sec": 20.0,
    "local_agree_dim": 2,
}


def _snapshot(
    worker_id: int, utilization: float, live_job_count: int = 1
) -> WorkerSnapshot:
    """
    Builds a worker snapshot for a live worker

    Args:
        worker_id       - Worker id to report
        utilization     - Rolling utilization to report
        live_job_count  - Jobs currently registered to the worker
    """
    return WorkerSnapshot(
        worker_id=worker_id,
        utilization=utilization,
        live_job_count=live_job_count,
        total_jobs_registered=live_job_count,
        context_ids={0, 1},
        alive=True,
        active_jobs=(),
    )


@pytest.fixture
def mock_logger():
    """
    Create a mocked logger instance for tests
    """
    return MagicMock(spec=Logger)


@pytest.fixture
def mock_worker_pool():
    """
    Create a mocked worker pool whose load_for_tags tests drive per case
    """
    return MagicMock(spec=WorkerPool)


@pytest.fixture
def provider(mock_logger: Logger, mock_worker_pool: WorkerPool):
    """
    Create a WhisperStreamingProvider over the mocked pool
    """
    return WhisperStreamingProvider(
        PROVIDER_CONFIG, mock_logger, mock_worker_pool, PROVIDER_KEY
    )


@pytest.mark.asyncio
async def test_reports_ok_when_a_live_worker_owns_the_contexts(
    provider: WhisperStreamingProvider, mock_worker_pool: MagicMock
):
    """
    Test a loaded model on an unsaturated worker reports ok
    """
    # Arrange
    workers = [_snapshot(0, 0.2), _snapshot(1, 0.4)]
    mock_worker_pool.load_for_tags.return_value = workers

    # Act
    health = await provider.describe_health()

    # Assert
    assert health.kind == ProviderKind.LOCAL
    assert health.status == ProviderStatus.OK
    assert health.model_loaded is True
    assert health.owning_workers == workers
    assert health.detail is None
    mock_worker_pool.load_for_tags.assert_called_once_with(
        (WHISPER_TAG, SILERO_TAG)
    )


@pytest.mark.asyncio
async def test_reports_down_when_no_live_worker_owns_the_contexts(
    provider: WhisperStreamingProvider, mock_worker_pool: MagicMock
):
    """
    Test the mis-set worker_ids/tags failure reports down and names itself

    This is the whole reason the endpoint exists: readiness returns 200 here,
    because the pool is fine - it is only this provider that can never route.
    """
    # Arrange
    mock_worker_pool.load_for_tags.return_value = []

    # Act
    health = await provider.describe_health()

    # Assert
    assert health.status == ProviderStatus.DOWN
    assert health.model_loaded is False
    assert health.owning_workers == []
    assert WHISPER_TAG in (health.detail or "")
    assert "worker_ids" in (health.detail or "")


@pytest.mark.asyncio
async def test_reports_degraded_when_every_owning_worker_is_saturated(
    provider: WhisperStreamingProvider, mock_worker_pool: MagicMock
):
    """
    Test a loaded but pinned provider is degraded, not down

    It is still transcribing, just behind realtime. An operator triages that
    differently from a model that never loaded.
    """
    # Arrange
    mock_worker_pool.load_for_tags.return_value = [
        _snapshot(0, 0.99),
        _snapshot(1, 0.96),
    ]

    # Act
    health = await provider.describe_health()

    # Assert
    assert health.status == ProviderStatus.DEGRADED
    assert health.model_loaded is True
    assert "saturated" in (health.detail or "")


@pytest.mark.asyncio
async def test_reports_ok_when_only_some_owning_workers_are_saturated(
    provider: WhisperStreamingProvider, mock_worker_pool: MagicMock
):
    """
    Test one worker with headroom keeps the provider ok

    Jobs route to the least utilized owner, so a single unsaturated worker
    means new sessions still land somewhere that can serve them.
    """
    # Arrange
    mock_worker_pool.load_for_tags.return_value = [
        _snapshot(0, 0.99),
        _snapshot(1, 0.10),
    ]

    # Act
    health = await provider.describe_health()

    # Assert
    assert health.status == ProviderStatus.OK


@pytest.mark.asyncio
async def test_does_not_call_a_cold_worker_saturated(
    provider: WhisperStreamingProvider, mock_worker_pool: MagicMock
):
    """
    Test a freshly booted worker holding no jobs is not reported degraded

    Rolling utilization reads 1.0 once a worker has recorded busy time but no
    idle time, which is exactly the state it is in right after creating its
    contexts. Utilization alone would call every cold start degraded.
    """
    # Arrange
    mock_worker_pool.load_for_tags.return_value = [
        _snapshot(0, 1.0, live_job_count=0)
    ]

    # Act
    health = await provider.describe_health()

    # Assert
    assert health.status == ProviderStatus.OK


@pytest.mark.asyncio
async def test_reports_active_session_count(
    provider: WhisperStreamingProvider, mock_worker_pool: MagicMock
):
    """
    Test open sessions are counted against the provider
    """
    # Arrange
    mock_worker_pool.load_for_tags.return_value = [_snapshot(0, 0.1)]
    provider.session_started()
    provider.session_started()
    provider.session_started()
    provider.session_ended()

    # Act
    health = await provider.describe_health()

    # Assert
    assert health.active_sessions == 2


@pytest.mark.asyncio
async def test_health_reads_no_state_that_could_perturb_transcription(
    provider: WhisperStreamingProvider, mock_worker_pool: MagicMock
):
    """
    Test the local health path never routes or registers work

    The endpoint is polled continuously by every operator browser, so it must
    stay a pure read of in-memory state.
    """
    # Arrange
    mock_worker_pool.load_for_tags.return_value = [_snapshot(0, 0.1)]

    # Act
    await provider.describe_health()

    # Assert
    mock_worker_pool.register_job.assert_not_called()
