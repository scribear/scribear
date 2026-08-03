"""
Defines interface for defining jobs
"""

from abc import ABC, abstractmethod
from typing import Generic, TypeVar

from src.shared.logger import Logger

C = TypeVar("C", bound=tuple)
D = TypeVar("D")
R = TypeVar("R")
Conf = TypeVar("Conf")


class JobInterface(ABC, Generic[C, D, R, Conf]):
    """
    Interface for defining job
    """

    @abstractmethod
    def process_batch(self, log: Logger, contexts: C, batch: list[D]) -> R:
        """
        Processes a batch of streaming data
        Called by WorkerPool with newly queued data when job is scheduled to run
        Note: batch can be empty

        Args:
            log         - Application logger
            contexts    - Context instances created by WorkerPool
            batch       - List containing queued data that hasn't been
                            processed yet in order data was queued

        Returns:
            Any job result
        """

    @abstractmethod
    def update_config(self, log: Logger, contexts: C, config: Conf) -> None:
        """
        Apply a config update mid-stream
        Called by WorkerPool between process_batch calls when a config update
        was queued via JobHandle.update_config.

        Args:
            log         - Application logger
            contexts    - Context instances created by WorkerPool
            config      - New config to apply
        """
        return

    def drain_counters(self) -> dict[str, float]:
        """
        Reports counters accumulated during the last execution and resets them

        Jobs run in a spawned process, so anything they count is invisible to
        the parent unless it rides back on a result. Called by the worker after
        every process_batch, successful or not - which is what lets a counter
        incremented immediately before a raise still be reported.

        Values must be per-execution deltas, not running totals; the parent
        keeps the monotonic totals so a worker restart cannot double count.

        Returns:
            Counter name to delta. Empty by default - jobs opt in by overriding.
        """
        return {}
