"""
Defines Schemas for transcription stream websocket client sent messages
"""

from enum import StrEnum
from typing import Any, Literal, Union

from pydantic import BaseModel, TypeAdapter


class ClientMessageTypes(StrEnum):
    """
    Defines possible client sent message types
    """

    AUTH = "auth"
    CONFIG = "config"


class AuthMessageSchema(BaseModel):
    """
    Authentication message JSON schema
    """

    type: Literal[ClientMessageTypes.AUTH] = ClientMessageTypes.AUTH
    api_key: str


class ConfigMessageSchema(BaseModel):
    """
    Configuration message JSON schema
    """

    type: Literal[ClientMessageTypes.CONFIG] = ClientMessageTypes.CONFIG
    config: Any


# Create pydantic adapter for client messages
ClientJsonMessage = Union[AuthMessageSchema, ConfigMessageSchema]
# pylint: disable=invalid-name
ClientJsonMessageAdapter = TypeAdapter[ClientJsonMessage](ClientJsonMessage)
