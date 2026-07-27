"""
Definition for job execution result
"""

from dataclasses import dataclass, field
from typing import Callable, Generic, Literal, TypeVar

R = TypeVar("R")

#: Counter name the *pool* writes into the `counters` dict of a job result, as
#: opposed to the ones a job reports through `JobInterface.drain_counters`.
#: Reserved: a job that reports this name has its value overwritten (see
#: `WorkerProcess._execute_job`), because the pool's count is the authoritative
#: one and a job must not be able to fabricate or suppress it.
#:
#: Counts periods for which a job never ran. The pool does not queue a period a
#: job overruns and does not error: `WorkerProcess._execute_job` advances
#: `period_start_ns` by whole periods until it passes now, so the missed periods
#: are dropped and the effective period silently becomes a multiple of the
#: configured one. Nothing else in the pool records that, which is why this is
#: counted rather than derived: `asr_rtf` cannot stand in for it, because RTF's
#: denominator is the audio one pass ingested and a dropped period leaves *more*
#: audio for the next pass - so RTF falls as periods are lost. Measured on a live
#: stack at 1/2/3/5/8 concurrent sessions sharing one worker, mean RTF went
#: 0.277 -> 0.256 -> 0.229 -> 0.194 -> 0.139 while the worker went 26% -> 94.5%
#: busy and transcripts per 1000 chunks collapsed 190 -> 48.
DROPPED_PERIODS_COUNTER = "dropped_periods"


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
    counters: dict[str, float] = field(default_factory=dict)
    has_exception: Literal[False] = False


@dataclass
class JobException:
    """
    Represents an unsuccessful job execution
    """

    value: Exception
    stats: JobStatistics
    counters: dict[str, float] = field(default_factory=dict)
    has_exception: Literal[True] = True


@dataclass
class JobExecutionObservation:
    """
    A single completed job execution, reported to an out-of-band observer

    Every execution the worker pool completes passes through here, successful
    or not, so an observer sees the whole population rather than the subset a
    particular provider happens to log. The pool attaches no meaning to
    `label`; it is whatever the caller passed to register_job, which lets the
    observer group executions without the pool knowing what a provider is.
    """

    worker_id: int
    job_id: int
    label: str
    stats: JobStatistics
    exception: Exception | None
    counters: dict[str, float]


JobObserver = Callable[[JobExecutionObservation], None]
