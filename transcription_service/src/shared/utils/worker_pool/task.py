"""
Defines task message objects for WorkerProcess
"""

from dataclasses import dataclass
from enum import IntEnum
from typing import Any, Literal

from .job_interface import JobInterface


class TaskType(IntEnum):
    """
    Types of tasks for WorkerProcess to process
    """

    TERMINATE_WORKER = 0
    REGISTER_JOB = 1
    DEREGISTER_JOB = 2
    QUEUE_DATA = 3


@dataclass
class TerminateWorkerTask:
    """
    Task to trigger WorkerProcess to exit
    """

    type: Literal[TaskType.TERMINATE_WORKER] = TaskType.TERMINATE_WORKER


@dataclass
class RegisterJobTask:
    """
    Task to register new job with WorkerProcess
    """

    job_id: int
    context_ids: tuple[int, ...]
    period_ms: int
    job: JobInterface[Any, Any, Any]
    type: Literal[TaskType.REGISTER_JOB] = TaskType.REGISTER_JOB


@dataclass
class DeregisterJobTask:
    """
    Task to deregister job with WorkerProcess
    """

    job_id: int
    type: Literal[TaskType.DEREGISTER_JOB] = TaskType.DEREGISTER_JOB


@dataclass
class QueueDataTask:
    """
    Task to queue data for a job
    """

    job_id: int
    data: list[Any]
    type: Literal[TaskType.QUEUE_DATA] = TaskType.QUEUE_DATA


type Task = TerminateWorkerTask | RegisterJobTask | DeregisterJobTask | QueueDataTask
