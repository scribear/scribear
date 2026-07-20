"""
Defines configuration schema for LumenGraniteProvider
"""

from typing import Optional

from pydantic import BaseModel, TypeAdapter


class LumenGraniteProviderConfig(BaseModel):
    """
    Provider-wide configuration for LumenGraniteProvider.

    Lumen (https://lumen.ncsa.illinois.edu) serves the
    `granite-speech-4.1-2b-plus` model behind an OpenAI-compatible audio
    transcription route (`POST {base_url}{request_path}`, multipart upload).
    There is no server-side streaming and no word/segment timestamps, so live
    captions are produced by re-transcribing a bounded, growing audio window
    each period (see the job for details).

    All fields come from `provider_config.json`; the upstream API key is never
    stored here - only the NAME of the env var that holds it (`api_key_env`).
    """

    # Endpoint (from lumen/README.md).
    base_url: str = "https://lumen.ncsa.illinois.edu/v1"
    request_path: str = "/audio/transcriptions"
    model: str = "granite-speech-4.1-2b-plus"

    # NAME of the env var holding the bearer token - never inline the secret.
    # deployment/compose.yml forwards TRANSCRIPTION_PROVIDER_API_KEY; the lumen
    # spike uses LUMEN_API_KEY. Set this to whichever the deployment exposes.
    api_key_env: Optional[str] = "LUMEN_API_KEY"

    # Optional steering. `language` is forwarded as the OpenAI `language` field.
    # `prompt` reaches the model but behaves like Whisper context, not an
    # instruction (see lumen/README.md) - it cannot force speaker tags.
    language: Optional[str] = None
    prompt: Optional[str] = None

    # Request behavior.
    timeout_sec: float = 30.0

    # Windowing. Re-POST the buffer every `job_period_ms`; once the buffered
    # audio reaches `max_buffer_len_sec`, commit the current transcript as a
    # final segment and start a fresh window (Granite exposes no timestamps, so
    # finalization is time-window based rather than word-aligned).
    job_period_ms: int = 3000
    max_buffer_len_sec: float = 20.0

    # Audio format the client is expected to stream (decoded to mono float32).
    sample_rate: int = 16000
    num_channels: int = 1


lumen_granite_config_adapter = TypeAdapter[LumenGraniteProviderConfig](
    LumenGraniteProviderConfig
)
