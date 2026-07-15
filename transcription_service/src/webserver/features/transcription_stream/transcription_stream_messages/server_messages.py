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

    TRANSCRIPT = "transcript"


@dataclass
class TranscriptSequence:
    """
    A transcription sequence with text and optional timestamps
    """

    text: list[str]
    starts: list[float] | None = None
    ends: list[float] | None = None


@dataclass
class TranscriptMessage(JsonServerMessage):
    """
    Message containing both finalized and in-progress transcription data
    """

    final: TranscriptSequence | None = None
    in_progress: TranscriptSequence | None = None
    type: Literal[ServerMessageTypes.TRANSCRIPT] = ServerMessageTypes.TRANSCRIPT
