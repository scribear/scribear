"""
Defines helper class that implements ServerMessage for dataclasses serializing to JSON
"""

import json
from dataclasses import asdict, dataclass

from src.webserver.shared.websocket_handler import ServerMessage


@dataclass
class JsonServerMessage(ServerMessage):
    """
    Implementation of ServerMessage for serializing dataclass objects to JSON

    Note:
    - Messages inheriting from this class must be annotated with @dataclass
    - Only properties with type annotations are serialized
        Remember to add type annotation for properties with default values

    Usage:
    ```
    @dataclass
    class SomeMessage(JsonServerMessage):
        int_arg: int
        str_arg: str
        with_default: str = "default_value"
    ```
    """

    def serialize(self):
        """
        Serializes dataclass into JSON string
        """
        return json.dumps(asdict(self), separators=(",", ":"))
