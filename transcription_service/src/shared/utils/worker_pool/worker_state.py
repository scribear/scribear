"""
Defines WorkerProcess states
"""

from enum import IntEnum


class WorkerState(IntEnum):
    """
    Represents the current state of the worker process

    ADMIN - Working on admin tasks (registering/deregistering jobs, queueing data, scheduling, etc.)
    IDLE  - No ready jobs and no admin tasks
    BUSY  - Actively executing job (could include initializing context)
    """

    ADMIN = 0
    IDLE = 1
    BUSY = 2
