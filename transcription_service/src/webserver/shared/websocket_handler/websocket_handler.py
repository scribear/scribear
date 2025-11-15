"""
Defines WebsocketHandler and related classes for helping manage websocket connections
"""

import asyncio
import uuid
from abc import ABC, abstractmethod

from starlette.types import Message
from starlette.websockets import WebSocket, WebSocketDisconnect, WebSocketState

from src.shared.logger import Logger


class ServerMessage(ABC):
    """
    Represents a server sent message

    Usage:
    ```
    class TextMsg(ServerMessage):
        def serialize(self) -> str:
            return "Hi"

    class BinaryMsg(ServerMessage):
        def serialize(self) -> bytes:
            return bytes("bytes", "utf-8")
    ```
    """

    @abstractmethod
    def serialize(self) -> str | bytes:
        """
        Serializes message for sending. Must return str or bytes.
        """


class WebsocketHandler(ABC):
    """
    Helper class for managing websocket connections.
    Manages connection lifecycle and errors and
        provides interface for sending messages and closing connections

    On error, _handle_error is called
    On text message, _handle_text_message is called
    On binary message, _handle_binary_message is called
    On close, _handle_close is called

    send() to send messages
    close() to close connection

    Usage:
    ```
    class SocketController(WebsocketHandler):
        def __init__(self, ws: WebSocket):
            super().__init__(ws)

        async def _handle_text_message(self, message: str):
            # Receiving a text message
            print("Text Msg:", message)

            self.send(TextMsg())  # Send a text message

        async def _handle_binary_message(self, message: bytes):
            # Receiving a binary message
            print("Binary Msg:", message)

            self.send(BinaryMsg())  # Send a binary messgae

        def _handle_error(self, error: Exception) -> bool:
            # Handle some error
            print("Error: ", error)

            return False  # Close connection after handling error (True if not)

        def _handle_close(self, code: int, reason: str):
            # Cleanup
            print("Close:", code, reason)


    router = APIRouter()

    @router.websocket("/websocket")
    async def websocket(ws: WebSocket):
        await SocketController(ws).receive_messages()

    return router
    ```
    """

    def __init__(self, logger: Logger, ws: WebSocket):
        super().__init__()
        self._ws = ws
        self._receive_task: asyncio.Task[None] | None = None
        self._socket_id = str(uuid.uuid4())
        self._logger = logger.child({"socket_id": self._socket_id})

    async def __internal_handle_message(self, msg: Message):
        """
        Internal WebsocketHandler middleware for handling messages before passing to _handle_message

        If message is disconnect message, calls _handle_close instead of _handle_message
        If message is websocket message, checks if message is text or binary and
            calls _handle_message appropriately

        Args:
            msg         - ASGI message object to handle

        Returns:
            True if websocket should be disconnected, False otherwise
        """
        if msg["type"] == "websocket.disconnect":
            code = 1006 if "code" not in msg else msg["code"]
            reason = "" if "reason" not in msg else msg["reason"]

            self._handle_close(code, reason)
            return True

        if msg["type"] == "websocket.receive":
            if "text" in msg:
                await self._handle_text_message(msg["text"])
            elif "bytes" in msg:
                await self._handle_binary_message(msg["bytes"])
        return False

    def __internal_handle_error(self, error: Exception):
        """
        Internal WebsocketHandler middleware for handling errors after _handle_error

        Closes websocket with code 1011 and reason "Internal Server Error"
            after handling error unless _handle_error prevents closing

        Args:
            error       - Exception to handle
        """
        prevent_close = self._handle_error(error)
        if not prevent_close:
            self.close(1011, "Internal Server Error")

    async def receive_messages(self):
        """
        Loop to receive messages from websocket, returns when websocket is closed
        This function should only be called within router and awaited to keep connection open

        Passes messages to _internal_handle_message and errors to _internal_handle_error
        """
        await self._ws.accept()
        self._logger.info("Websockect connection established")

        while True:
            try:
                if (
                    self._ws.application_state != WebSocketState.CONNECTED
                    or self._ws.client_state != WebSocketState.CONNECTED
                ):
                    # Stop receiving messages once no longer connected
                    return

                msg = await self._ws.receive()

                if await self.__internal_handle_message(msg):
                    # Stop receiving messages once close message is received
                    return
            except Exception as error:  # pylint: disable=broad-exception-caught
                self.__internal_handle_error(error)

    def send(self, message: ServerMessage):
        """
        Sends message via websocket

        Ignores if websocket is diconnected,
        otherwise errors are passed to _internal_handle_error
        """

        async def _send():
            """
            AsyncIO task for sending message so that send() is synchronous
            Must ensure this function doesn't throw errors
            """
            try:
                serialized_message = message.serialize()
                if isinstance(serialized_message, str):
                    await self._ws.send_text(serialized_message)
                else:
                    await self._ws.send_bytes(serialized_message)
            except WebSocketDisconnect:
                # Disconnect event is handled by receive_messages()
                pass
            except Exception as error:  # pylint: disable=broad-exception-caught
                self.__internal_handle_error(error)

        asyncio.create_task(_send())

    def close(self, code: int = 1000, reason: str | None = None):
        """
        Closes websocket

        Args:
            close       - Websocket close code
            reason      - Websocket close reason
        """

        async def _close():
            """
            AsyncIO task for closing websocket so that close() is synchronous
            Must ensure this function doesn't throw errors
            """
            if self._ws.application_state == WebSocketState.CONNECTED:
                try:
                    await self._ws.close(code, reason)
                except:  # pylint: disable=bare-except
                    pass

        asyncio.create_task(_close())

    @abstractmethod
    async def _handle_text_message(self, message: str):
        """
        Message handler that is called when a websocket receives a text message
        Should be overrided by children classes for handling messages

        Args:
            message     - Text message received
        """

    @abstractmethod
    async def _handle_binary_message(self, message: bytes):
        """
        Message handler that is called when a websocket receives a binary message
        Should be overrided by children classes for handling messages

        Args:
            message     - Binary message received
        """

    @abstractmethod
    def _handle_close(self, code: int, reason: str | None):
        """
        Message handler that is called when a websocket closes
        Should be overrided by children classes for handling cleanup

        Args:
            code        - Websocket close code
            reason      - Websocket close reason
        """

    @abstractmethod
    def _handle_error(self, error: Exception) -> bool:
        """
        Message handler that is called when an error occurs when receiving or sending messages
        Should be overrided by children classes for custom error handling

        Args:
            error       - Exception to be handled

        Returns:
            True to prevent closing connection after handling error,
            False to automatically close websocket with code 1011 and reason "Internal Server Error"
        """
