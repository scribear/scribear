"""
Unit tests for ContextLogger
"""

import logging
from typing import Any
from unittest.mock import MagicMock

import pytest

from src.shared.logger import ContextLogger

BASE_CONTEXT: dict[str, Any] = {"base": "property", "override": "CHANGE_ME!"}
ADDITIONAL_CONTEXT: dict[str, Any] = {
    "override": "changed!",
    "another": "property",
}
COMBINED_CONTEXT: dict[str, Any] = {
    "base": "property",
    "override": "changed!",
    "another": "property",
}
MESSAGE = "This is a standard log message."


@pytest.fixture
def mock_logger():
    """Provides a mock logger for testing."""
    return MagicMock(spec=logging.Logger)


@pytest.fixture
def base_logger(mock_logger: MagicMock) -> ContextLogger:
    """
    Provides a ContextLogger instance with base context
    """
    return ContextLogger(mock_logger, context=BASE_CONTEXT)


def test_initialization_without_context(mock_logger: MagicMock):
    """
    Test that the logger initialized with no context passes no context to logger
    """
    # Arrange / Act
    logger = ContextLogger(mock_logger)
    logger.log(logging.INFO, MESSAGE)

    # Assert
    mock_logger.log.assert_called_once_with(
        logging.INFO, MESSAGE, extra={"context": {}}
    )


def test_initialization_with_context(mock_logger: MagicMock):
    """
    Test that the logger initialized with context passes context to logger
    """
    # Arrange / Act
    logger = ContextLogger(mock_logger, context=BASE_CONTEXT)
    logger.log(logging.INFO, MESSAGE)

    # Assert
    mock_logger.log.assert_called_once_with(
        logging.INFO, MESSAGE, extra={"context": BASE_CONTEXT}
    )


def test_child_is_context_logger(base_logger: ContextLogger):
    """
    Test that child is an instance of ContextLogger
    """
    # Arrange / Act
    child = base_logger.child()

    # Assert
    assert isinstance(child, ContextLogger)


def test_child_inherits_parent_context(
    base_logger: ContextLogger, mock_logger: MagicMock
):
    """
    Test that a child logger inherits the parent's context
    """
    # Arrange / Act
    child = base_logger.child()
    child.log(logging.INFO, MESSAGE)

    # Assert
    mock_logger.log.assert_called_once_with(
        logging.INFO, MESSAGE, extra={"context": BASE_CONTEXT}
    )


def test_child_adds_new_context(
    base_logger: ContextLogger, mock_logger: MagicMock
):
    """
    Test that a child logger correctly merges parent and provided context
    """
    # Arrange / Act
    child = base_logger.child(ADDITIONAL_CONTEXT)
    child.log(logging.INFO, MESSAGE)

    # Assert
    mock_logger.log.assert_called_once_with(
        logging.INFO, MESSAGE, extra={"context": COMBINED_CONTEXT}
    )


def test_child_does_not_modify_parent(
    base_logger: ContextLogger, mock_logger: MagicMock
):
    """
    Test that a child logger merges parent and provided context without modifying parent
    """
    # Arrange / Act
    _ = base_logger.child(ADDITIONAL_CONTEXT)
    base_logger.log(logging.INFO, MESSAGE)

    # Assert
    mock_logger.log.assert_called_once_with(
        logging.INFO, MESSAGE, extra={"context": BASE_CONTEXT}
    )


def test_ad_hoc_context_inherits_parent_context(
    base_logger: ContextLogger, mock_logger: MagicMock
):
    """
    Test that ad hoc context correctly merges parent and provided context
    """
    # Arrange / Act
    base_logger.log(logging.INFO, MESSAGE, context=ADDITIONAL_CONTEXT)

    # Assert
    mock_logger.log.assert_called_once_with(
        logging.INFO, MESSAGE, extra={"context": COMBINED_CONTEXT}
    )


def test_logger_provides_context_property(base_logger: ContextLogger):
    """
    Test that logger provides current context as a property
    """
    # Arrange / Act / Assert
    assert base_logger.context == BASE_CONTEXT
