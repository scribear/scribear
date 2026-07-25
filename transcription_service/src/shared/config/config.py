"""
Defines Config class for loading and providing application configuration
"""

import os
import socket
import sys
from enum import StrEnum
from typing import Any, cast

import dotenv
from pydantic import BaseModel, Field, TypeAdapter, field_validator
from pydantic.networks import IPvAnyAddress

from src.shared.logger import LogLevel


class EnvSchema(BaseModel):
    """
    dotenv file schema definition
    """

    LOG_LEVEL: LogLevel = Field(default=LogLevel.INFO)

    PORT: int = Field(ge=0, le=65_535)
    HOST: IPvAnyAddress

    API_KEY: str
    WS_INIT_TIMEOUT_SEC: float

    # Defaulted, unlike every other key here: EnvSchema has no defaults except
    # LOG_LEVEL, so a required addition would break every existing deployment
    # and every test that builds a real Config. Empty means "metrics endpoint
    # disabled", which keeps this change additive.
    METRICS_API_KEY: str = ""

    # Defaulted for the same reason. Empty means this host publishes no fleet
    # telemetry, and so opens no Redis connection at all - rather than one that
    # retries a connection nobody configured, forever.
    REDIS_URL: str = ""

    # Identity this host publishes its telemetry under. Empty resolves to the
    # hostname, which under compose and Kubernetes is already the container or
    # pod name, so several hosts get distinct identities with no configuration.
    # `validate_default` so the hostname fallback and the ':' check below apply
    # even when the variable is unset, which is the common case.
    TRANSCRIPTION_HOST_ID: str = Field(default="", validate_default=True)

    # Defaulted for the same reason, and to the same 0.01 both `AudioMeter` and
    # whisper's `silence_threshold` already use, so the shipped classification
    # of silence does not change. Settable because the webserver's own ingress
    # meter has no provider config to read a threshold from, and the number is
    # room-dependent - a hall with loud HVAC needs a higher floor before
    # "silent" means anything.
    AUDIO_SILENCE_THRESHOLD: float = 0.01

    PROVIDER_CONFIG_PATH: str

    @field_validator("TRANSCRIPTION_HOST_ID")
    @classmethod
    def _resolve_transcription_host_id(cls, value: str) -> str:
        """
        Resolves the published host identity and rejects one that could forge
        a key elsewhere in the telemetry namespace

        Keys are built by interpolating this into `scribe:v1:ts:{host}`, so a
        value containing `:` would let this host write over another part of the
        namespace. It is checked once here, at boot, rather than on every
        heartbeat: a misconfiguration should stop the process, not be
        rediscovered five times a second.

        The hostname fallback is applied here too, so the value that reaches
        the check is the one that will actually be published.
        """
        host_id = value or socket.gethostname()
        if ":" in host_id:
            raise ValueError(
                "TRANSCRIPTION_HOST_ID must not contain ':' - it is "
                "interpolated into telemetry Redis keys"
            )
        return host_id


class JobContextDefinitionUID(StrEnum):
    """
    Defines UIDs of all job context definitions
    """

    FASTER_WHISPER = "faster-whisper"
    SILERO_VAD = "silero-vad"


class JobContextConfigSchema(BaseModel):
    """
    Base config schema for a job context definition
    """

    context_uid: JobContextDefinitionUID
    worker_ids: list[int]
    tags: list[str]
    context_config: Any


class TranscriptionProviderUID(StrEnum):
    """
    Defines UIDs of all transcriptions providers
    """

    DEBUG = "debug"
    WHISPER_STREAMING = "whisper-streaming"
    LUMEN_GRANITE = "lumen-granite"


class TranscriptionProviderConfigSchema(BaseModel):
    """
    Base config schema for a transcription provider
    """

    provider_uid: TranscriptionProviderUID
    provider_config: Any


class ProviderConfigFileSchema(BaseModel):
    """
    Provider config file schema
    """

    num_workers: int
    contexts: list[JobContextConfigSchema]
    providers: dict[str, TranscriptionProviderConfigSchema]


# pylint: disable=invalid-name
ProviderConfigFileAdapter = TypeAdapter[ProviderConfigFileSchema](
    ProviderConfigFileSchema
)


class Config:
    """
    Class for loading and providing application configuration
    """

    @property
    def log_level(self) -> LogLevel:
        """
        Logging level to use
        """
        return self._log_level

    @property
    def is_development(self) -> bool:
        """
        If app is in development mode or not
        """
        return self._is_development

    @property
    def port(self) -> int:
        """
        Port webserver should listen on
        """
        return self._port

    @property
    def host(self) -> str:
        """
        IP address of network interface webserver should bind to
        """
        return self._host

    @property
    def api_key(self) -> str:
        """
        Secret API key for authentication transcription stream websockets
        """
        return self._api_key

    @property
    def metrics_api_key(self) -> str:
        """
        Secret API key for reading the metrics endpoint

        Separate from api_key on purpose - that one opens transcription
        sessions, this one only reads counters. Empty disables the endpoint.
        """
        return self._metrics_api_key

    @property
    def redis_url(self) -> str:
        """
        Connection URL for the fleet telemetry backplane

        Empty disables publishing entirely - no connection is opened. Telemetry
        is the only thing that reads it; transcription never touches Redis.
        """
        return self._redis_url

    @property
    def transcription_host_id(self) -> str:
        """
        Identity this host publishes its telemetry under

        Already resolved and validated: never empty, never contains ':'.
        """
        return self._transcription_host_id

    @property
    def audio_silence_threshold(self) -> float:
        """
        Linear RMS threshold below which the ingress audio meter reads silence

        Only the webserver's own ingress meter reads it; a provider that meters
        its own stage still uses whatever its provider config says, so the two
        can be tuned independently for a deployment where they legitimately
        differ.
        """
        return self._audio_silence_threshold

    @property
    def ws_init_timeout_sec(self) -> float:
        """
        Seconds to wait for websocket to send initialization messages before closing if not sent
        """
        return self._ws_init_timeout_sec

    @property
    def provider_config(self) -> ProviderConfigFileSchema:
        """
        Transcription provider config loaded from provider config file
        """
        return self._provider_config

    def __init__(self, dotenv_path: str | None = None):
        """
        Args:
            dotenv_path   - Optional file path to load .env from
        """
        self._is_development = "--dev" in sys.argv

        dotenv.load_dotenv(dotenv_path=dotenv_path)
        env = EnvSchema(**cast(Any, dict(os.environ)))

        self._log_level = env.LOG_LEVEL

        self._port = env.PORT
        self._host = str(env.HOST)
        self._api_key = env.API_KEY
        self._metrics_api_key = env.METRICS_API_KEY
        self._redis_url = env.REDIS_URL
        self._transcription_host_id = env.TRANSCRIPTION_HOST_ID
        self._audio_silence_threshold = env.AUDIO_SILENCE_THRESHOLD
        self._ws_init_timeout_sec = env.WS_INIT_TIMEOUT_SEC

        with open(env.PROVIDER_CONFIG_PATH, "r", encoding="utf-8") as file:
            self._provider_config = ProviderConfigFileAdapter.validate_json(
                file.read()
            )
