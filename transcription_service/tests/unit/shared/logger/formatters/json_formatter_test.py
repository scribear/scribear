"""
Unit tests for JsonFormatter
"""

import io
import json
import logging
import os
import socket
from datetime import datetime, timezone
from typing import Any

import pytest
from freezegun import freeze_time

from src.shared.logger import JsonFormatter

TIMESTAMP = 1058832226  # Tue Jul 22 2003 00:03:46 GMT+0000
TIMESTAMP_DATETIME = datetime.fromtimestamp(TIMESTAMP, tz=timezone.utc)

MESSAGE = "This is a standard log message."


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
    formatter = JsonFormatter()
    handler.setFormatter(formatter)

    _logger.addHandler(handler)

    return _logger


def test_log_with_context(logger: logging.Logger, log_stream: io.StringIO):
    """
    Tests that context passed via the 'extra' dictionary is included in logs
    """
    # Arrange
    extra_context: dict[str, Any] = {"num": 12345, "str": "hi!"}

    # Act
    with freeze_time(TIMESTAMP_DATETIME):
        logger.info(MESSAGE, extra={"context": extra_context})

    # Assert
    log_data = json.loads(log_stream.getvalue())

    assert log_data == {
        "level": logging.INFO,
        "time": TIMESTAMP,
        "pid": os.getpid(),
        "hostname": socket.gethostname(),
        "msg": MESSAGE,
        "num": 12345,
        "str": "hi!",
    }


def test_log_no_context(logger: logging.Logger, log_stream: io.StringIO):
    """
    Test that debug logs are formatted correctly without context
    """
    # Act
    with freeze_time(TIMESTAMP_DATETIME):
        logger.info(MESSAGE)

    # Assert
    log_data = json.loads(log_stream.getvalue())

    assert log_data == {
        "level": logging.INFO,
        "time": TIMESTAMP,
        "pid": os.getpid(),
        "hostname": socket.gethostname(),
        "msg": MESSAGE,
    }
