"""
Unit tests for JsonServerMessage
"""

from dataclasses import dataclass

from src.webserver.shared.json_server_message import JsonServerMessage


@dataclass
class SomeMessage(JsonServerMessage):
    """
    JsonServerMessage implementation for testing
    """

    int_arg: int
    str_arg: str
    with_default: str = "default_value"


def test_json_server_message_serializes_dataclass():
    """
    Test that JsonServerMessage correctly serializes dataclass instance
    """
    # Arrange
    message = SomeMessage(10, "string")

    # Act
    serialized = message.serialize()

    # Assert
    assert (
        serialized
        == '{"int_arg":10,"str_arg":"string","with_default":"default_value"}'
    )
