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

    @property
    def device(self) -> str | None:
        """
        The inference device this context runs on, if it has one

        Reported on ``/metrics/status`` via the provider registry's
        ``provider_device`` property, so the monitoring sidecar can select
        per-device alert thresholds. Defaults to ``None``: a context that has
        no device concept (Silero VAD, which always runs on CPU) contributes
        nothing to the device map.

        Returning the *effective* device — the value the context was
        configured with and actually uses — rather than re-validating the raw
        config elsewhere keeps a single source of truth. If a future context
        normalises ``"auto"`` to ``"cuda"`` at construction time, this
        property reports the resolved value.
        """
        return None

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
