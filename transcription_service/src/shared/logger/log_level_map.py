"""
Defines LOG_LEVEL_MAP function for converting LogLevel enum to logging level number
"""

import logging

from .logger_types import LogLevel

# Maps LogLevel enum to corresponding logging level number
LOG_LEVEL_MAP = {
    LogLevel.DEBUG: logging.DEBUG,
    LogLevel.INFO: logging.INFO,
    LogLevel.WARNING: logging.WARNING,
    LogLevel.ERROR: logging.ERROR,
    LogLevel.FATAL: logging.FATAL,
}
