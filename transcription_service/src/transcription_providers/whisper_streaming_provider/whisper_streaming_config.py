"""
Defines configuration schema for WhisperStreamingProvider
"""

from typing import Optional

from pydantic import BaseModel, TypeAdapter


class WhisperStreamingProviderConfig(BaseModel):
    """
    Provider configuration format for WhisperStreamingProvider
    """

    whisper_context_tag: str
    silero_context_tag: str
    job_period_ms: int
    max_buffer_len_sec: float
    local_agree_dim: int
    vad_detector: bool = False
    vad_threshold: float = 0.5
    vad_neg_threshold: Optional[float] = None
    silence_threshold: float = 0.01

    # Guard thresholds over Whisper's own quality signals (see
    # TranscriptionJobCounter). Configurable rather than hardcoded so a
    # maintainer can retune them from observed false-positive/negative rates
    # without a code change.
    compression_ratio_guard_threshold: float = 2.4
    avg_logprob_guard_threshold: float = -1.0
    no_speech_prob_guard_threshold: float = 0.6


whisper_streaming_config_adapter = TypeAdapter[WhisperStreamingProviderConfig](
    WhisperStreamingProviderConfig
)
