"""
Unit tests for EventEmitter
"""

import pytest
from pytest_mock import MockerFixture

from src.shared.utils.event_emitter import Event, EventEmitter

# Define some events to be used across tests
no_arg_event = Event[[]]("no_arg")
arg_event = Event[[str, int]]("arg")


@pytest.fixture
def emitter():
    """
    Provides a fresh EventEmitter instance for each test
    """
    return EventEmitter()


def test_on_and_emit_single_listener_no_args(
    emitter: EventEmitter, mocker: MockerFixture
):
    """
    Test that a single listener can be registered and is called on emit
    """
    # Arrange
    mock_callback = mocker.Mock()
    emitter.on(no_arg_event, mock_callback)

    # Act
    emitter.emit(no_arg_event)

    # Assert
    mock_callback.assert_called_once_with()


def test_on_and_emit_single_listener_with_args(
    emitter: EventEmitter, mocker: MockerFixture
):
    """
    Test that a single listener can be registered and is called on emit
    """
    # Arrange
    mock_callback = mocker.Mock()
    emitter.on(arg_event, mock_callback)

    # Act
    emitter.emit(arg_event, "str", 100)

    # Assert
    mock_callback.assert_called_once_with("str", 100)


def test_emit_with_keyword_args(emitter: EventEmitter, mocker: MockerFixture):
    """
    Test that keyword arguments are passed correctly
    """

    # Arrange
    def dummy_callback(num: int, msg: str, key: str = "", val: int = 0):
        # pylint: disable=unused-argument
        pass

    kwarg_event = Event("kwarg", callback_type=dummy_callback)

    mock_callback = mocker.Mock()
    emitter.on(kwarg_event, mock_callback)

    # Act
    emitter.emit(kwarg_event, 100, "str", key="key", val=10)

    # Assert
    mock_callback.assert_called_once_with(100, "str", key="key", val=10)


def test_on_and_emit_multiple_listeners(
    emitter: EventEmitter, mocker: MockerFixture
):
    """
    Test that multiple listeners for the same event are all called
    """
    # Arrange
    mock_callback_0 = mocker.Mock()
    emitter.on(arg_event, mock_callback_0)

    mock_callback_1 = mocker.Mock()
    emitter.on(arg_event, mock_callback_1)

    # Act
    emitter.emit(arg_event, "str", 100)

    # Assert
    mock_callback_0.assert_called_once_with("str", 100)
    mock_callback_1.assert_called_once_with("str", 100)


def test_emit_with_no_listeners(emitter: EventEmitter):
    """
    Test that emitting an event with no listeners does not raise an error
    """
    try:
        # Act
        emitter.emit(no_arg_event)
    except Exception as e:  # pylint: disable=broad-except
        # Assert
        pytest.fail(f"emit() raised an exception unexpectedly: {e}")


def test_emit_only_calls_correct_listeners(
    emitter: EventEmitter, mocker: MockerFixture
):
    """
    Ensures emitting an event only triggers listeners for that specific event
    """
    # Arrange
    no_arg_callback = mocker.Mock()
    emitter.on(no_arg_event, no_arg_callback)

    arg_callback = mocker.Mock()
    emitter.on(arg_event, arg_callback)

    # Act
    emitter.emit(arg_event, "str", 100)

    # Assert
    no_arg_callback.assert_not_called()
    arg_callback.assert_called_once_with("str", 100)


def test_once_listener_is_called_only_once(
    emitter: EventEmitter, mocker: MockerFixture
):
    """
    Test that a `once` listener is called once and then automatically removed
    """
    # Arrange
    mock_callback = mocker.Mock()
    emitter.once(no_arg_event, mock_callback)

    # Act
    emitter.emit(no_arg_event)
    emitter.emit(no_arg_event)

    # Assert
    mock_callback.assert_called_once()  # Still called only once


def test_remove_listener(emitter: EventEmitter, mocker: MockerFixture):
    """
    Tests that a specific listener can be removed
    """
    # Arrange
    permanent_callback = mocker.Mock()
    emitter.on(no_arg_event, permanent_callback)

    removable_callback = mocker.Mock()
    emitter.on(no_arg_event, removable_callback)

    # Act
    emitter.remove_listener(no_arg_event, removable_callback)
    emitter.emit(no_arg_event)

    # Assert
    permanent_callback.assert_called_once_with()
    removable_callback.assert_not_called()


def test_remove_all_listeners_for_event(
    emitter: EventEmitter, mocker: MockerFixture
):
    """
    Test removing all listeners for a specific event
    """
    # Arrange
    no_arg_callback = mocker.Mock()
    emitter.on(no_arg_event, no_arg_callback)

    arg_callback = mocker.Mock()
    emitter.on(arg_event, arg_callback)

    # Act
    emitter.remove_all_listeners(no_arg_event)
    emitter.emit(no_arg_event)
    emitter.emit(arg_event, "str", 100)

    # Assert
    no_arg_callback.assert_not_called()
    arg_callback.assert_called_once_with("str", 100)


def test_remove_all_listeners_global(
    emitter: EventEmitter, mocker: MockerFixture
):
    """
    Test removing all listeners from the emitter instance
    """
    # Arrange
    no_arg_callback = mocker.Mock()
    emitter.on(no_arg_event, no_arg_callback)

    arg_callback = mocker.Mock()
    emitter.on(arg_event, arg_callback)

    # Act
    emitter.remove_all_listeners()
    emitter.emit(no_arg_event)
    emitter.emit(arg_event, "str", 100)

    # Assert
    no_arg_callback.assert_not_called()
    arg_callback.assert_not_called()
