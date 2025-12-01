"""
Defines configuration schema for WhisperStreamingProvider
"""
from typing import Optional
from pydantic import BaseModel, TypeAdapter


class WhisperStreamingProviderConfig(BaseModel):
    """
    Provider configuration format for WhisperStreamingProvider
    """

    context_tag: str
    vad_context_tag: str = "silero_vad"
    job_period_ms: int
    max_buffer_len_sec: float
    local_agree_dim: int
    vad_detector: bool = True
    vad_threshold: float = 0.5
    vad_neg_threshold: Optional[float] = None
    silence_threshold: float = 0.01


whisper_streaming_config_adapter = TypeAdapter[WhisperStreamingProviderConfig](
    WhisperStreamingProviderConfig
)
