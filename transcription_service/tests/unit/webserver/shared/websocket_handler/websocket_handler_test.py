"""
Unit tests for WebsocketHandler
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import pytest
from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from src.shared.logger import Logger
from src.webserver.shared.websocket_handler import (
    ServerMessage,
    WebsocketHandler,
)


class _TextMsg(ServerMessage):
    """
    Test ServerMessage for sending text
    """

    def __init__(self, text: str):
        self._text = text

    def serialize(self) -> str:
        return self._text


class _BinaryMsg(ServerMessage):
    """
    Test ServerMessage for sending bytes
    """

    def __init__(self, data: bytes):
        self._data = data

    def serialize(self) -> bytes:
        return self._data


class _ErrorMsg(ServerMessage):
    """
    Test ServerMessage that raises an error on serialization
    """

    def __init__(self, error: Exception):
        self._error = error

    def serialize(self) -> str | bytes:
        raise self._error


class _TestWebsocketHandler(WebsocketHandler):
    """
    An implementation of WebsocketHandler for testing
    Uses mocks to record calls to abstract methods
    """

    def __init__(self, ws: WebSocket):
        super().__init__(MagicMock(spec=Logger), ws)
        self.handle_text_mock = MagicMock()
        self.handle_binary_mock = MagicMock()
        self.handle_close_mock = MagicMock()
        self.handle_error_mock = MagicMock(return_value=False)

    async def _handle_text_message(self, message: str):
        await asyncio.sleep(0)  # Sleep to force use of async loop
        self.handle_text_mock(message)

    async def _handle_binary_message(self, message: bytes):
        await asyncio.sleep(0)  # Sleep to force use of async loop
        self.handle_binary_mock(message)

    def _handle_close(self, code: int, reason: str | None):
        self.handle_close_mock(code, reason)

    def _handle_error(self, error: Exception) -> bool:
        return self.handle_error_mock(error)


@pytest.fixture
def mock_websocket():
    """
    Provides a Mock for the WebSocket object.
    """
    mock_ws = MagicMock(spec=WebSocket)
    mock_ws.accept = AsyncMock()
    mock_ws.close = AsyncMock()
    mock_ws.send_text = AsyncMock()
    mock_ws.send_bytes = AsyncMock()
    mock_ws.receive = AsyncMock()
    # Set initial states
    mock_ws.client_state = WebSocketState.CONNECTED
    mock_ws.application_state = WebSocketState.CONNECTED
    return mock_ws


@pytest.fixture
def handler(mock_websocket: MagicMock):
    """
    Provides an instance of the _TestWebsocketHandler with a mocked WebSocket for each test
    """
    return _TestWebsocketHandler(mock_websocket)


@pytest.mark.asyncio
async def test_receive_disconnect_message(
    handler: _TestWebsocketHandler, mock_websocket: MagicMock
):
    """
    Test that a disconnect message from client calls the close handler and stops receive loop

    Note: Other tests depend on receive_messages() returns on disconnect message
    """
    # Arrange
    mock_websocket.receive.side_effect = [
        {"type": "websocket.disconnect", "code": 1001, "reason": "Going away"}
    ]

    # Act
    # The loop should exit after the disconnect message.
    await handler.receive_messages()

    # Assert
    handler.handle_close_mock.assert_called_once_with(1001, "Going away")
    handler.handle_text_mock.assert_not_called()
    handler.handle_binary_mock.assert_not_called()


@pytest.mark.asyncio
async def test_receive_loop_stops_on_disconnect_state(
    handler: _TestWebsocketHandler, mock_websocket: MagicMock
):
    """
    Test that the receive loop terminates and receive is not attempted
    if websocket is not longer connected
    """
    # Arrange
    mock_websocket.client_state = WebSocketState.DISCONNECTED

    # Act
    await handler.receive_messages()

    # Assert
    mock_websocket.receive.assert_not_awaited()
    handler.handle_close_mock.assert_not_called()


@pytest.mark.asyncio
async def test_receive_messages_accepts_connection(
    handler: _TestWebsocketHandler, mock_websocket: MagicMock
):
    """
    Test that receive_messages calls accept() on the websocket
    """
    # Arrange
    mock_websocket.receive.side_effect = [{"type": "websocket.disconnect"}]

    # Act
    await handler.receive_messages()

    # Assert
    mock_websocket.accept.assert_awaited_once()


@pytest.mark.asyncio
async def test_receive_text_message(
    handler: _TestWebsocketHandler, mock_websocket: MagicMock
):
    """
    Test that a received text message is correctly handled
    """
    # Arrange
    text_data = "hello world"
    mock_websocket.receive.side_effect = [
        {"type": "websocket.receive", "text": text_data},
        {"type": "websocket.disconnect"},
    ]

    # Act
    await handler.receive_messages()

    # Assert
    handler.handle_text_mock.assert_called_once_with("hello world")
    handler.handle_binary_mock.assert_not_called()


@pytest.mark.asyncio
async def test_receive_binary_message(
    handler: _TestWebsocketHandler, mock_websocket: MagicMock
):
    """
    Test that a received binary message is correctly handled.
    """
    # Arrange
    binary_data = b"\x01\x02\x03"
    mock_websocket.receive.side_effect = [
        {"type": "websocket.receive", "bytes": binary_data},
        {"type": "websocket.disconnect"},
    ]

    # Act
    await handler.receive_messages()

    # Assert
    handler.handle_binary_mock.assert_called_once_with(binary_data)
    handler.handle_text_mock.assert_not_called()


@pytest.mark.asyncio
async def test_receive_exception_calls_error_handler(
    handler: _TestWebsocketHandler, mock_websocket: MagicMock
):
    """
    Test that an exception during receive() calls the error handler
    """
    # Arrange
    test_exception = ValueError("Test error")
    mock_websocket.receive.side_effect = [
        test_exception,
        {"type": "websocket.disconnect"},
    ]

    # Act
    await handler.receive_messages()

    # Assert
    handler.handle_error_mock.assert_called_once_with(test_exception)


@pytest.mark.asyncio
async def test_handle_text_message_exception_calls_error_handler(
    handler: _TestWebsocketHandler, mock_websocket: MagicMock
):
    """
    Test that an exception during _handle_text_message() calls the error handler
    """
    # Arrange
    test_exception = ValueError("Test error")
    handler.handle_text_mock.side_effect = [test_exception]
    mock_websocket.receive.side_effect = [
        {"type": "websocket.receive", "text": "hello world"},
        {"type": "websocket.disconnect"},
    ]

    # Act
    await handler.receive_messages()

    # Assert
    handler.handle_error_mock.assert_called_once_with(test_exception)


@pytest.mark.asyncio
async def test_handle_binary_message_exception_calls_error_handler(
    handler: _TestWebsocketHandler, mock_websocket: MagicMock
):
    """
    Test that an exception during _handle_binary_message() calls the error handler
    """
    # Arrange
    test_exception = ValueError("Test error")
    handler.handle_binary_mock.side_effect = [test_exception]
    mock_websocket.receive.side_effect = [
        {"type": "websocket.receive", "bytes": b"\x01\x02\x03"},
        {"type": "websocket.disconnect"},
    ]

    # Act
    await handler.receive_messages()

    # Assert
    handler.handle_error_mock.assert_called_once_with(test_exception)


@pytest.mark.asyncio
async def test_error_handler_closes_socket_when_returns_false(
    handler: _TestWebsocketHandler, mock_websocket: MagicMock
):
    """
    Test that the connection is closed if the error handler returns False.
    """
    # Arrange
    mock_websocket.receive.side_effect = [
        ValueError("Test error"),
        {"type": "websocket.disconnect"},
    ]
    handler.handle_error_mock.return_value = False

    # Act
    await handler.receive_messages()
    await asyncio.sleep(0)  # Wait for async tasks to finish

    # Assert
    mock_websocket.close.assert_awaited_once_with(1011, "Internal Server Error")


@pytest.mark.asyncio
async def test_error_handler_prevents_close_when_returns_true(
    handler: _TestWebsocketHandler, mock_websocket: MagicMock
):
    """
    Test that the connection is not closed if the error handler returns True.
    """
    # Arrange
    mock_websocket.receive.side_effect = [
        ValueError("Test error"),
        {"type": "websocket.disconnect"},
    ]
    handler.handle_error_mock.return_value = True

    # Act
    await handler.receive_messages()

    # Assert
    mock_websocket.close.assert_not_awaited()


@pytest.mark.asyncio
async def test_close_connection(
    handler: _TestWebsocketHandler, mock_websocket: MagicMock
):
    """
    Test that close method closes websocket connection if open
    """
    # Arrange/Act
    handler.close(code=1000, reason="Normal closure")
    await asyncio.sleep(0)  # Wait for async tasks to finish

    # Assert
    mock_websocket.close.assert_awaited_once_with(1000, "Normal closure")


@pytest.mark.asyncio
async def test_close_does_nothing_if_already_disconnected(
    handler: _TestWebsocketHandler, mock_websocket: MagicMock
):
    """
    Test that websocket close() is not called if the websocket is already disconnected
    """
    # Arrange
    mock_websocket.application_state = WebSocketState.DISCONNECTED

    # Act
    handler.close()
    await asyncio.sleep(0)

    # Assert
    mock_websocket.close.assert_not_awaited()


@pytest.mark.asyncio
async def test_send_text_message(
    handler: _TestWebsocketHandler, mock_websocket: MagicMock
):
    """
    Test sending a text message
    """
    # Arrange
    text = "hello from server"
    message = _TextMsg(text)

    # Act
    handler.send(message)
    await asyncio.sleep(0)  # Wait for async tasks to finish

    # Assert
    mock_websocket.send_text.assert_awaited_once_with(text)
    mock_websocket.send_bytes.assert_not_awaited()


@pytest.mark.asyncio
async def test_send_binary_message(
    handler: _TestWebsocketHandler, mock_websocket: MagicMock
):
    """
    Test sending a binary message
    """
    # Arrange
    binary_data = b"server data"
    message = _BinaryMsg(binary_data)

    # Act
    handler.send(message)
    await asyncio.sleep(0)  # Wait for async tasks to finish

    # Assert
    mock_websocket.send_bytes.assert_awaited_once_with(binary_data)
    mock_websocket.send_text.assert_not_awaited()


@pytest.mark.asyncio
async def test_send_handles_serialization_error(handler: _TestWebsocketHandler):
    """
    Test that an error during message serialization is handled
    """
    # Arrange
    test_exception = ValueError("Test error")
    message = _ErrorMsg(test_exception)

    # Act
    handler.send(message)
    await asyncio.sleep(0)  # Wait for async tasks to finish

    # Assert
    handler.handle_error_mock.assert_called_once_with(test_exception)


@pytest.mark.asyncio
async def test_send_ignores_websocket_disconnect(
    handler: _TestWebsocketHandler, mock_websocket: MagicMock
):
    """
    Test that sending on a disconnected socket does not raise an unhandled exception
    """
    # Arrange
    mock_websocket.send_text.side_effect = WebSocketDisconnect(1001)
    message = _TextMsg("This will fail")

    # Act
    handler.send(message)
    await asyncio.sleep(0)  # Wait for async tasks to finish

    # Assert
    handler.handle_error_mock.assert_not_called()
