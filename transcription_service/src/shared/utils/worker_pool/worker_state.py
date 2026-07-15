"""
Defines WorkerProcess states
"""

from enum import IntEnum


class WorkerState(IntEnum):
    """
    Represents the current state of the worker process

    IDLE  - No ready jobs and no pending admin tasks
    BUSY  - Actively executing job, draining admin tasks, or scheduling
    """

    IDLE = 1
    BUSY = 2
