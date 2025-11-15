"""
Test context definitions
"""

import time
from dataclasses import dataclass

from src.shared.logger import Logger
from src.shared.utils.worker_pool import JobContextInterface


@dataclass
class ContextInstance:
    """
    Test context instance
    """

    context_id: int
    create_count: int
    destroy_count: int


class Context(JobContextInterface[ContextInstance]):
    """
    Definition for context that reports the number of times it is created/destroyed for testing
    """

    def __init__(self, context_id: int):
        """
        Args:
            context_id  - Identifier for created context instance
        """
        super().__init__(None, 2, ["context", "no_error"], None, 0)
        self._context_id = context_id
        self._create_count = 0
        self._destroy_count = 0

    def create(self, log: Logger) -> ContextInstance:
        self._create_count += 1
        return ContextInstance(
            self._context_id, self._create_count, self._destroy_count
        )

    def destroy(self, log: Logger, context: ContextInstance) -> None:
        assert self._context_id == context.context_id
        assert self._create_count == context.create_count
        assert self._destroy_count == context.destroy_count

        self._destroy_count += 1


class ErrorContext(JobContextInterface[None]):
    """
    Definition for context that raises exception when it is created for testing
    """

    def __init__(self):
        super().__init__(None, -1, ["error"], None, 0)

    def create(self, log: Logger) -> None:
        raise RuntimeError("Failed Create Context")

    def destroy(self, log: Logger, context: None) -> None:
        raise NotImplementedError("Should Not Be Called")


class LoggerContext(JobContextInterface[None]):
    """
    Definition for context that uses logger for testing
    """

    def __init__(self):
        super().__init__(
            None, -1, ["no_error", "none_context", "log_context"], None, 0.1
        )

    def create(self, log: Logger) -> None:
        log.info("Create Context")

    def destroy(self, log: Logger, context: None) -> None:
        log.info("Destroy Context")


class SlowContext(JobContextInterface[int]):
    """
    Definition for slow context for testing
    """

    def __init__(self, work_time_ns: int):
        """
        Args:
            work_time_ns    - Nanoseconds slow context should take to create
        """
        super().__init__(
            None,
            2,
            ["slow_context", "no_error", "none_context"],
            "log_context",
            0.1,
        )
        self._work_time_ns = work_time_ns

    def create(self, log: Logger) -> int:
        end_time = time.perf_counter_ns() + self._work_time_ns
        while time.perf_counter_ns() < end_time:
            pass
        return self._work_time_ns

    def destroy(self, log: Logger, context: int) -> None:
        log.info("Destroy Context")
