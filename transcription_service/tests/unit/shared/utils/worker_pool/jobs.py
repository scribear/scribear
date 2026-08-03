"""
Test job definitions
"""

import time
from dataclasses import dataclass

from src.shared.logger import Logger
from src.shared.utils.worker_pool import JobInterface

from .context_definitions import ContextInstance


class SumJob(JobInterface[tuple[()], int, int, None]):
    """
    Definition for job that sums batch elements for testing
    """

    def process_batch(
        self, log: Logger, contexts: tuple[()], batch: list[int]
    ) -> int:
        return sum(batch)

    def update_config(self, log: Logger, contexts: tuple, config: None) -> None:
        return


@dataclass
class ConfigBatchResult:
    """
    Result emitted by ConfigJob containing the config active at process_batch time
    and the batch that was processed
    """

    config: int
    batch: list[int]


class ConfigJob(JobInterface[tuple[()], int, ConfigBatchResult, int]):
    """
    Definition for job that reports the active config alongside each batch
    Used to verify that config updates split batches correctly
    """

    def __init__(self, initial_config: int):
        """
        Args:
            initial_config  - Config value to start with
        """
        self._config = initial_config

    def process_batch(
        self, log: Logger, contexts: tuple[()], batch: list[int]
    ) -> ConfigBatchResult:
        return ConfigBatchResult(config=self._config, batch=list(batch))

    def update_config(
        self, log: Logger, contexts: tuple[()], config: int
    ) -> None:
        self._config = config


class ConfigErrorJob(JobInterface[tuple[()], int, int, int]):
    """
    Definition for job whose update_config raises an exception for testing
    """

    def process_batch(
        self, log: Logger, contexts: tuple[()], batch: list[int]
    ) -> int:
        return sum(batch)

    def update_config(
        self, log: Logger, contexts: tuple[()], config: int
    ) -> None:
        raise RuntimeError(f"update_config failed for config: {config}")


class ErrorJob(JobInterface[tuple[()], None, None, None]):
    """
    Definition for job that raises exception for testing
    """

    def process_batch(
        self, log: Logger, contexts: tuple[()], batch: list[None]
    ) -> None:
        raise RuntimeError("Failed Process Batch")

    def update_config(self, log: Logger, contexts: tuple, config: None) -> None:
        return


class ContextJob(
    JobInterface[tuple[ContextInstance], None, ContextInstance, None]
):
    """
    Definition for job that returns context for testing
    """

    def process_batch(
        self, log: Logger, contexts: tuple[ContextInstance], batch: list[None]
    ) -> ContextInstance:
        return contexts[0]

    def update_config(self, log: Logger, contexts: tuple, config: None) -> None:
        return


class LoggerJob(JobInterface[tuple[()], None, None, None]):
    """
    Definition for job that uses logger for testing
    """

    def process_batch(
        self, log: Logger, contexts: tuple[()], batch: list[None]
    ) -> None:
        log.info("Process Batch")

    def update_config(self, log: Logger, contexts: tuple, config: None) -> None:
        return


class SlowJob(JobInterface[tuple[()], None, None, None]):
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

    def update_config(self, log: Logger, contexts: tuple, config: None) -> None:
        return


class CountingJob(JobInterface[tuple[()], int, int, None]):
    """
    Definition for job that reports per-execution counters for testing

    Counts the items it processed and, when asked, raises after counting - the
    shape of a real job whose only signal for an event is the exception it
    then throws.
    """

    def __init__(self, fail: bool = False):
        """
        Args:
            fail    - Whether process_batch should raise after counting
        """
        self._fail = fail
        self._counters: dict[str, float] = {}

    def process_batch(
        self, log: Logger, contexts: tuple[()], batch: list[int]
    ) -> int:
        self._counters["items"] = self._counters.get("items", 0) + len(batch)
        if self._fail:
            raise RuntimeError("Failed after counting")
        return sum(batch)

    def drain_counters(self) -> dict[str, float]:
        drained = self._counters
        self._counters = {}
        return drained

    def update_config(self, log: Logger, contexts: tuple, config: None) -> None:
        return
