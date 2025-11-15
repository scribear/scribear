"""
Unit tests for create_logger
"""

from src.shared.logger import (
    ContextLogger,
    JsonFormatter,
    LogLevel,
    create_logger,
)


def test_create_logger_returns_context_logger():
    """
    Test that create logger function returns instance of ContextLogger
    """
    # Arrange / Act
    logger = create_logger(LogLevel.DEBUG, JsonFormatter())

    # Assert
    assert isinstance(logger, ContextLogger)
