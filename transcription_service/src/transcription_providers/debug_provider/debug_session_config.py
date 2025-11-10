"""
Defines configuration schema for DebugProvider
"""

from pydantic import BaseModel, TypeAdapter


class DebugSessionConfig(BaseModel):
    """
    Session configuration schema for DebugProvider
    """

    sample_rate: int
    num_channels: int


debug_session_config_adapter = TypeAdapter[DebugSessionConfig](
    DebugSessionConfig
)
