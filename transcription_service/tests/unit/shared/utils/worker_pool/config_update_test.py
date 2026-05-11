"""
Unit tests for on-the-fly config updates queued via JobHandle.update_config
"""

import asyncio

import pytest

from src.shared.utils.worker_pool import (
    JobException,
    JobSuccess,
    WorkerProcessManager,
)

from .jobs import ConfigBatchResult, ConfigErrorJob, ConfigJob

pytestmark = pytest.mark.timeout(2)


@pytest.mark.asyncio
async def test_config_update_splits_batch(wpm: WorkerProcessManager):
    """
    Test that an update_config queued between two queue_data calls produces
    two process_batch invocations with the old and new config values
    """
    # Arrange
    results: list[JobSuccess[ConfigBatchResult] | JobException] = []
    job = wpm.register_job((), 200, ConfigJob(initial_config=10))
    job.on(job.JobResultEvent, results.append)

    # Act
    job.queue_data([1, 2])
    job.update_config(20)
    job.queue_data([3, 4])
    await asyncio.sleep(0.2 + 0.1)

    # Assert
    assert len(results) == 2
    assert results[0].has_exception is False
    assert results[0].value == ConfigBatchResult(config=10, batch=[1, 2])
    assert results[1].has_exception is False
    assert results[1].value == ConfigBatchResult(config=20, batch=[3, 4])


@pytest.mark.asyncio
async def test_multiple_config_updates_in_one_period(wpm: WorkerProcessManager):
    """
    Test that multiple update_config calls within a period produce one
    process_batch per segment, each with its corresponding config value
    """
    # Arrange
    results: list[JobSuccess[ConfigBatchResult] | JobException] = []
    job = wpm.register_job((), 200, ConfigJob(initial_config=1))
    job.on(job.JobResultEvent, results.append)

    # Act
    job.queue_data([10])
    job.update_config(2)
    job.queue_data([20])
    job.update_config(3)
    job.queue_data([30])
    await asyncio.sleep(0.2 + 0.1)

    # Assert
    assert len(results) == 3
    assert results[0].value == ConfigBatchResult(config=1, batch=[10])
    assert results[1].value == ConfigBatchResult(config=2, batch=[20])
    assert results[2].value == ConfigBatchResult(config=3, batch=[30])


@pytest.mark.asyncio
async def test_consecutive_config_updates_preserve_order(
    wpm: WorkerProcessManager,
):
    """
    Test that two consecutive update_config calls (no data between them)
    both apply in order, producing empty-batch process_batch calls at the
    segment boundaries
    """
    # Arrange
    results: list[JobSuccess[ConfigBatchResult] | JobException] = []
    job = wpm.register_job((), 200, ConfigJob(initial_config=1))
    job.on(job.JobResultEvent, results.append)

    # Act
    job.queue_data([100])
    job.update_config(2)
    job.update_config(3)
    job.queue_data([200])
    await asyncio.sleep(0.2 + 0.1)

    # Assert
    assert len(results) == 3
    assert results[0].value == ConfigBatchResult(config=1, batch=[100])
    assert results[1].value == ConfigBatchResult(config=2, batch=[])
    assert results[2].value == ConfigBatchResult(config=3, batch=[200])


@pytest.mark.asyncio
async def test_config_update_with_no_preceding_data(wpm: WorkerProcessManager):
    """
    Test that update_config queued before any data produces an empty
    process_batch under the old config followed by data under the new config
    """
    # Arrange
    results: list[JobSuccess[ConfigBatchResult] | JobException] = []
    job = wpm.register_job((), 200, ConfigJob(initial_config=1))
    job.on(job.JobResultEvent, results.append)

    # Act
    job.update_config(2)
    job.queue_data([5])
    await asyncio.sleep(0.2 + 0.1)

    # Assert
    assert len(results) == 2
    assert results[0].value == ConfigBatchResult(config=1, batch=[])
    assert results[1].value == ConfigBatchResult(config=2, batch=[5])


@pytest.mark.asyncio
async def test_config_update_persists_across_periods(wpm: WorkerProcessManager):
    """
    Test that a config update applied in one period stays in effect for
    subsequent periods where no further updates are queued
    """
    # Arrange
    results: list[JobSuccess[ConfigBatchResult] | JobException] = []
    job = wpm.register_job((), 200, ConfigJob(initial_config=1))
    job.on(job.JobResultEvent, results.append)

    # Act
    job.queue_data([10])
    job.update_config(2)
    job.queue_data([20])
    await asyncio.sleep(0.2 + 0.1)

    job.queue_data([30])
    await asyncio.sleep(0.2)

    # Assert
    assert len(results) == 3
    assert results[0].value == ConfigBatchResult(config=1, batch=[10])
    assert results[1].value == ConfigBatchResult(config=2, batch=[20])
    assert results[2].value == ConfigBatchResult(config=2, batch=[30])


@pytest.mark.asyncio
async def test_config_update_error_returns_exception_and_stops_job(
    wpm: WorkerProcessManager,
):
    """
    Test that an exception raised by update_config emits a JobException and
    prevents further scheduling of the job (same as process_batch errors)
    """
    # Arrange
    results: list[JobSuccess[int] | JobException] = []
    job = wpm.register_job((), 200, ConfigErrorJob())
    job.on(job.JobResultEvent, results.append)

    # Act
    job.queue_data([1, 2])
    job.update_config(99)
    job.queue_data([3, 4])
    await asyncio.sleep(0.2 + 0.1)
    await asyncio.sleep(0.4)

    # Assert
    assert len(results) == 2
    assert results[0].has_exception is False
    assert results[0].value == 3
    assert results[1].has_exception is True
    assert isinstance(results[1].value, RuntimeError)
