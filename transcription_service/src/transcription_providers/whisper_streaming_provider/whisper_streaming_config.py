"""
Defines configuration schema for WhisperStreamingProvider
"""

from pydantic import BaseModel, TypeAdapter


class WhisperStreamingProviderConfig(BaseModel):
    """
    Provider configuration format for WhisperStreamingProvider
    """

    context_tag: str
    job_period_ms: int
    max_buffer_len_sec: float
    local_agree_dim: int
    vad_detector: bool = False
    silence_threshold: float = 0.01


whisper_streaming_config_adapter = TypeAdapter[WhisperStreamingProviderConfig](
    WhisperStreamingProviderConfig
)
