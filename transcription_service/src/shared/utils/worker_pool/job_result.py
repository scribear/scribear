"""
Definition for job execution result
"""

from dataclasses import dataclass
from typing import Generic, Literal, TypeVar

R = TypeVar("R")


@dataclass
class JobStatistics:
    """
    Holds job execution time statistics
    """

    @property
    def scheduling_delay_ns(self):
        """
        Time (ns) between when job became ready to run to when job was scheduled to run
        """
        return self.job_scheduled_time_ns - self.period_start_ns

    @property
    def context_initialization_time_ns(self):
        """
        Time (ns) that job spent initializing job context
        """
        return self.start_execute_time_ns - self.job_scheduled_time_ns

    @property
    def execution_time_ns(self):
        """
        Time (ns) that job spent executing
        """
        return self.complete_time_ns - self.start_execute_time_ns

    @property
    def total_time_ns(self):
        """
        Total time (ns) job spent in worker pool
        """
        return self.complete_time_ns - self.period_start_ns

    period_start_ns: int
    job_scheduled_time_ns: int
    start_execute_time_ns: int
    complete_time_ns: int


@dataclass
class JobSuccess(Generic[R]):
    """
    Represents a successful job execution
    """

    value: R
    stats: JobStatistics
    has_exception: Literal[False] = False


@dataclass
class JobException:
    """
    Represents an unsuccessful job execution
    """

    value: Exception
    stats: JobStatistics
    has_exception: Literal[True] = True
