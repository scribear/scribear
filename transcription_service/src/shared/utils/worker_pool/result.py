"""
Defines result message objects for WorkerProcess
"""

import logging
from dataclasses import dataclass
from enum import IntEnum
from typing import Any, Literal

from .job_result import JobException, JobSuccess
from .worker_state import WorkerState


class ResultType(IntEnum):
    """
    Types of results for WorkerProcess to send
    """

    INITIALIZE_WORKER = 0
    LOGGING = 1
    STATE_CHANGE = 2
    JOB_EXECUTION = 3


@dataclass
class InitializeWorkerResult:
    """
    Result for when WorkerProcess is fully initialized
    """

    type: Literal[ResultType.INITIALIZE_WORKER] = ResultType.INITIALIZE_WORKER


@dataclass
class LoggingResult:
    """
    Result for when WorkerProcess needs to write logs
    """

    record: logging.LogRecord
    type: Literal[ResultType.LOGGING] = ResultType.LOGGING


@dataclass
class StateChangeResult:
    """
    Result for when WorkerProcess changes state
    """

    state: WorkerState
    time_elapsed_ns: int
    type: Literal[ResultType.STATE_CHANGE] = ResultType.STATE_CHANGE


@dataclass
class JobExecutionResult:
    """
    Result for when WorkerProcess completes execution of a job
    """

    job_id: int
    result: JobSuccess[Any] | JobException
    type: Literal[ResultType.JOB_EXECUTION] = ResultType.JOB_EXECUTION


type Result = InitializeWorkerResult | LoggingResult | StateChangeResult | JobExecutionResult
