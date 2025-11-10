"""
Defines setup_logger function for initializing application logger
"""

import io
import logging
import sys
from typing import cast

from .context_logger import ContextLogger
from .log_level_map import LOG_LEVEL_MAP
from .logger_types import Logger, LogLevel


def create_logger(
    log_level: LogLevel,
    formatter: logging.Formatter,
    output_stream: io.TextIOBase = cast(io.TextIOBase, sys.stderr),
) -> Logger:
    """
    Initializes application logger instance with provided configuration

    Args:
        log_level       - Logging level to logger should log at
        formatter       - Log formatter logger should use
        output_stream   - Stream logger should output to

    Returns:
        Configured application logger instance
    """
    logger = logging.getLogger()
    if log_level not in LOG_LEVEL_MAP:
        raise KeyError(f"Provided log level: '{log_level}' is not valid.")
    logger.setLevel(LOG_LEVEL_MAP[log_level])

    # Remove any existing handlers to avoid duplicate logs
    logger.handlers.clear()

    handler = logging.StreamHandler(output_stream)

    handler.setFormatter(formatter)
    logger.addHandler(handler)

    return ContextLogger(logger)
