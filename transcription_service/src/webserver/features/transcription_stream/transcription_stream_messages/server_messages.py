"""
Defines messages for transcription stream websocket server sent messages
"""

from dataclasses import dataclass
from enum import StrEnum
from typing import Literal

from src.webserver.shared.json_server_message import JsonServerMessage


class ServerMessageTypes(StrEnum):
    """
    Defines possible server send message types
    """

    IP_TRANSCRIPT = "ip_transcript"
    FINAL_TRANSCRIPT = "final_transcript"


@dataclass
class IPTranscriptMessage(JsonServerMessage):
    """
    Message for updating the in progress transcription
    """

    text: list[str]
    starts: list[float] | None = None
    ends: list[float] | None = None
    type: Literal[ServerMessageTypes.IP_TRANSCRIPT] = (
        ServerMessageTypes.IP_TRANSCRIPT
    )


@dataclass
class FinalTranscriptMessage(JsonServerMessage):
    """
    Message for appending final transcription
    """

    text: list[str]
    starts: list[float] | None = None
    ends: list[float] | None = None
    type: Literal[ServerMessageTypes.FINAL_TRANSCRIPT] = (
        ServerMessageTypes.FINAL_TRANSCRIPT
    )
