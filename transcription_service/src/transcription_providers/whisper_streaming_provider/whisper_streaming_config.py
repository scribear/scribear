"""
Defines configuration schema for WhisperStreamingProvider
"""

from typing import Optional

from pydantic import BaseModel, TypeAdapter, model_validator


class WhisperStreamingProviderConfig(BaseModel):
    """
    Provider configuration format for WhisperStreamingProvider
    """

    whisper_context_tag: str
    silero_context_tag: str
    job_period_ms: int
    max_buffer_len_sec: float
    local_agree_dim: int

    # `max_buffer_len_sec` used to do three jobs: hard buffer capacity (past
    # which incoming audio is dropped and counted - see
    # WhisperStreamingProviderJob._decode_audio), the tail length that
    # triggers a force-commit-and-purge, and the span handed to Whisper each
    # pass. Split into three so a deployment can bound per-pass transcribe
    # cost independently of how much backlog it tolerates. Both default to
    # `max_buffer_len_sec` when unset, so a config carrying only the old
    # field - or an older service still reading one written by a newer
    # config - behaves exactly as before.
    force_finalize_len_sec: Optional[float] = None
    max_transcribe_len_sec: Optional[float] = None

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

    @model_validator(mode="after")
    def _resolve_bounded_tail_fields(self) -> "WhisperStreamingProviderConfig":
        """
        Resolves the force-finalize and max-transcribe defaults, then
        enforces the two invariants the bounded-tail split depends on.

        `force_finalize_len_sec` must be at least `max_transcribe_len_sec`:
        the transcribe window slides across whatever the buffer holds
        front-first, and finalization is what advances it. If the tail could
        be force-purged before the window ever reached it, that audio is
        dropped having never been transcribed - silent caption loss, not a
        performance regression, so it is rejected here rather than degrading
        quietly at runtime.

        `job_period_ms` must not exceed `max_buffer_len_sec` in
        milliseconds: a job scheduled less often than the buffer can hold
        guarantees an overflow on every single pass, even with exactly one
        session and no contention.
        """
        if self.force_finalize_len_sec is None:
            self.force_finalize_len_sec = self.max_buffer_len_sec
        if self.max_transcribe_len_sec is None:
            self.max_transcribe_len_sec = self.max_buffer_len_sec

        if self.force_finalize_len_sec < self.max_transcribe_len_sec:
            raise ValueError(
                "force_finalize_len_sec "
                f"({self.force_finalize_len_sec}) must be >= "
                f"max_transcribe_len_sec ({self.max_transcribe_len_sec}) - "
                "otherwise the tail can be force-purged before it is ever "
                "transcribed"
            )

        if self.job_period_ms > self.max_buffer_len_sec * 1000:
            raise ValueError(
                f"job_period_ms ({self.job_period_ms}) must not exceed "
                f"max_buffer_len_sec ({self.max_buffer_len_sec}) in "
                "milliseconds - otherwise every pass overflows the buffer"
            )

        return self


whisper_streaming_config_adapter = TypeAdapter[WhisperStreamingProviderConfig](
    WhisperStreamingProviderConfig
)
