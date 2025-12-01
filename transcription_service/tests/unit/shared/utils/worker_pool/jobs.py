"""
Test job definitions
"""

import time

from src.shared.logger import Logger
from src.shared.utils.worker_pool import JobInterface

from .context_definitions import ContextInstance


class SumJob(JobInterface[tuple[()], int, int]):
    """
    Definition for job that sums batch elements for testing
    """

    def process_batch(
        self, log: Logger, contexts: tuple[()], batch: list[int]
    ) -> int:
        return sum(batch)


class ErrorJob(JobInterface[tuple[()], None, None]):
    """
    Definition for job that raises exception for testing
    """

    def process_batch(
        self, log: Logger, contexts: tuple[()], batch: list[None]
    ) -> None:
        raise RuntimeError("Failed Process Batch")


class ContextJob(JobInterface[tuple[ContextInstance], None, ContextInstance]):
    """
    Definition for job that returns context for testing
    """

    def process_batch(
        self, log: Logger, contexts: tuple[ContextInstance], batch: list[None]
    ) -> ContextInstance:
        return contexts[0]


class LoggerJob(JobInterface[tuple[()], None, None]):
    """
    Definition for job that uses logger for testing
    """

    def process_batch(
        self, log: Logger, contexts: tuple[()], batch: list[None]
    ) -> None:
        log.info("Process Batch")


class SlowJob(JobInterface[tuple[()], None, None]):
    """
    Definition for slow job for testing
    """

    def __init__(self, work_time_ns: int):
        """
        Args:
            work_time_ns    - Nanoseconds slow job should run for
        """
        self._work_time_ns = work_time_ns

    def process_batch(
        self, log: Logger, contexts: tuple[()], batch: list[None]
    ) -> None:
        end_time = time.perf_counter_ns() + self._work_time_ns
        while time.perf_counter_ns() < end_time:
            pass
