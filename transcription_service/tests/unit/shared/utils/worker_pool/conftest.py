"""
Shared pytest fixtures for worker_pool test modules
"""

import logging
from typing import Any
from unittest.mock import MagicMock

import pytest
import pytest_asyncio

from src.shared.logger import ContextLogger
from src.shared.utils.worker_pool import (
    JobContextInterface,
    WorkerProcessManager,
)

NS_PER_SEC = 10**9
TEST_WORKER_ID = 0
# Shrunk for tests so utilization assertions don't have to wait minutes
TEST_ROLLING_UTILIZATION_WINDOW_NS = 3 * NS_PER_SEC


@pytest.fixture
def mock_underlying_logger():
    """
    Create a mocked logger instance for tests
    """
    logger = MagicMock(spec=logging.Logger)
    logger.level = 10
    return logger


@pytest.fixture
def context_defs() -> dict[int, JobContextInterface[Any]]:
    """
    Default empty context_defs used by WorkerProcessManager fixture.
    Override in a test module to pre-initialize specific contexts on the worker.
    """
    return {}


@pytest_asyncio.fixture
async def wpm(
    mock_underlying_logger: logging.Logger,
    context_defs: dict[int, JobContextInterface[Any]],
):
    """
    Create a fresh WorkerProcessManager for each test and handle teardown
    """
    wpm = WorkerProcessManager(
        ContextLogger(mock_underlying_logger),
        TEST_WORKER_ID,
        context_defs,
        rolling_utilization_window_ns=TEST_ROLLING_UTILIZATION_WINDOW_NS,
    )

    yield wpm

    wpm.send_terminate()
    wpm.wait_shutdown()
