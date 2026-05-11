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
