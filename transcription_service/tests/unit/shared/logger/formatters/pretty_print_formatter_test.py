"""
Unit tests for PrettyPrintFormatter
"""

import io
import logging
import os
import re
from datetime import datetime, timezone

import pytest
from freezegun import freeze_time

from src.shared.logger import PrettyPrintFormatter

TIMESTAMP = 1058832226.123  # Tue Jul 22 2003 00:03:46 GMT+0000
TIMESTAMP_DATETIME = datetime.fromtimestamp(TIMESTAMP, tz=timezone.utc)
record = logging.LogRecord("", 0, "", 0, "", None, None)
record.created = TIMESTAMP
TIME_STR = logging.Formatter().formatTime(record, "%H:%M:%S") + ".123"
MESSAGE = "This is a standard log message."


def remove_ansi_escape_codes(text: str):
    """
    Removes all ansi escape codes from provided text
    """
    ansi_escape = re.compile(r"\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
    return ansi_escape.sub("", text)


@pytest.fixture
def log_stream():
    """
    Log output stream fixture to capture log output
    """
    return io.StringIO()


@pytest.fixture
def logger(log_stream: io.StringIO):
    """
    Fixture to create a logger with the PrettyPrintFormatter
    """
    # Create a logger
    _logger = logging.getLogger()
    _logger.setLevel(logging.DEBUG)

    # Output logs to our stream fixture
    handler = logging.StreamHandler(log_stream)
    formatter = PrettyPrintFormatter()
    handler.setFormatter(formatter)

    _logger.addHandler(handler)

    return _logger


def test_log_with_context(logger: logging.Logger, log_stream: io.StringIO):
    """
    Tests that context passed via the 'extra' dictionary is included in logs
    """
    extra_context: dict[str, object] = {"num": 12345, "str": "hi!"}

    # Act
    with freeze_time(TIMESTAMP_DATETIME):
        logger.info(MESSAGE, extra={"context": extra_context})

    # Assert
    log_data = remove_ansi_escape_codes(log_stream.getvalue())

    expected = f"[{TIME_STR}] INFO ({os.getpid()}): {MESSAGE}"
    expected += """
    {
        "num": 12345,
        "str": "hi!"
    }\n"""

    assert log_data == expected


def test_log_no_context(logger: logging.Logger, log_stream: io.StringIO):
    """
    Test that debug logs are formatted correctly in pretty print without context
    """
    # Act
    with freeze_time(TIMESTAMP_DATETIME):
        logger.info(MESSAGE)

    # Assert
    log_data = remove_ansi_escape_codes(log_stream.getvalue())

    assert log_data == f"[{TIME_STR}] INFO ({os.getpid()}): {MESSAGE}\n"
