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
    Used by WorkerPool to create and destroy context instances
    """

    @property
    def max_instances(self) -> int:
        """
        Maximum number of worker processes that can instantiate this context
        """
        return self._max_instances

    @property
    def tags(self) -> set[str]:
        """
        Set of tags that context is assigned
        Used by WorkerPool to select context to be used for a job
        """
        return self._tags

    @property
    def negative_affinity(self) -> str | None:
        """
        Tag that context is has negative affinity with
        Used by WorkerPool to select context to be used for a job
        """
        return self._negative_affinity

    @property
    def creation_cost(self) -> float:
        """
        Cost weight of creating a job, higher means slower creation
        Used by WorkerPool to select context to be used for a job
        """
        return self._creation_cost

    # pylint: disable=unused-argument
    def __init__(
        self,
        context_config: object,
        max_instances: int,
        tags: list[str],
        negative_affinity: str | None,
        creation_cost: float,
    ):
        """
        Args:
            context_config      - JobContext implementation dependent config
            max_instances       - Maximum instances configured for job context
            tags                - List of tags configured for job context
            negative_affinity   - Negative affinity tag configured for job context
            creation_cost       - Cost weight of creating this context
        """
        self._max_instances = max_instances
        self._tags = set(tags)
        self._negative_affinity = negative_affinity
        self._creation_cost = creation_cost

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
