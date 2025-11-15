"""
Defines types used by logger
"""

from enum import StrEnum

from .context_logger import ContextLogger


class LogLevel(StrEnum):
    """
    Enum for log level configuration
    """

    DEBUG = "debug"
    INFO = "info"
    WARNING = "warn"
    ERROR = "error"
    FATAL = "fatal"


# Alias for application logger type
Logger = ContextLogger
