"""
Defines a custom log formatter for json logs
"""

import json
import logging
import socket
from typing import Mapping


class JsonFormatter(logging.Formatter):
    """
    Custom formatter for machine-readable JSON logs
    Logs severity, timestamp, process id, hostname, message and additional context
    """

    def __init__(self):
        super().__init__()
        # Get hostname once rather than per log event
        self._hostname = socket.gethostname()

    def format(self, record: logging.LogRecord) -> str:
        log_object: Mapping[str, object] = {
            "level": record.levelno,
            "time": int(self.formatTime(record, "%s")),
            "pid": record.process,
            "hostname": self._hostname,
            "msg": record.getMessage(),
        }

        if record.exc_info:
            log_object["exc_info"] = self.formatException(record.exc_info)
        if record.stack_info:
            log_object["stack_info"] = self.formatStack(record.stack_info)

        if "context" in record.__dict__:
            log_object.update(record.__dict__["context"])

        return json.dumps(log_object, separators=(",", ":"))
