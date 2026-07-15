"""
Defines interface for job context definitions
"""

from abc import ABC, abstractmethod
from typing import Generic, TypeVar

from src.shared.logger import Logger

JobContextInstance = TypeVar("JobContextInstance")


class JobContextInterface(ABC, Generic[JobContextInstance]):
    """
    Interface for defining job context
    Used by WorkerPool to create context instances at worker startup. Contexts
    are pinned to specific workers via the pool's configuration and are created
    eagerly when the worker process starts.
    """

    @property
    def tags(self) -> set[str]:
        """
        Set of tags assigned to this context
        Used by WorkerPool to route jobs requesting matching tags to workers
        that own a context with at least one of those tags
        """
        return self._tags

    def __init__(self, tags: list[str]):
        """
        Args:
            tags    - Tags configured for job context
        """
        self._tags = set(tags)

    @abstractmethod
    def create(self, log: Logger) -> JobContextInstance:
        """
        Create job context instance
        """

    @abstractmethod
    def destroy(self, log: Logger, context: JobContextInstance) -> None:
        """
        Cleanup job context instance
        """
