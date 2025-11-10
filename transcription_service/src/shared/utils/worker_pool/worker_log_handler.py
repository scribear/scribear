"""
Defines WorkerLogHandler for pushing logs to result queue
"""

import logging
from queue import Queue

from .result import LoggingResult, Result


class WorkerLogHandler(logging.Handler):
    """
    Custom logger handler for pushing logs to result queue

    Usage:
    ```
    logger = logging.getLogger()
    logger.addHandler(WorkerLogHandler(result_queue))
    ```
    """

    def __init__(self, result_queue: Queue[Result]) -> None:
        """
        Args:
            result_queue  - Queue for which log results should be written to
        """
        super().__init__()
        self._result_queue = result_queue

    def emit(self, record: logging.LogRecord):
        """
        Pushes log record to result queue
        Adheres to python logging.Handler.emit interface.

        Args:
            record      - Log record to handle
        """
        self._result_queue.put(LoggingResult(record))
