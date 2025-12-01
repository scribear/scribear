"""
Defines Config class for loading and providing application configuration
"""

import os
import sys
from enum import StrEnum
from typing import Any, cast

import dotenv
from pydantic import BaseModel, Field, TypeAdapter
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

    PROVIDER_CONFIG_PATH: str


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
    max_instances: int
    tags: list[str]
    negative_affinity: str | None
    creation_cost: float
    context_config: Any


class TranscriptionProviderUID(StrEnum):
    """
    Defines UIDs of all transcriptions providers
    """

    DEBUG = "debug"
    WHISPER_STREAMING = "whisper-streaming"


class TranscriptionProviderConfigSchema(BaseModel):
    """
    Base config schema for a transcription provider
    """

    provider_key: str
    provider_uid: TranscriptionProviderUID
    provider_config: Any


class ProviderConfigFileSchema(BaseModel):
    """
    Provider config file schema
    """

    num_workers: int
    rolling_utilization_window_sec: float
    contexts: list[JobContextConfigSchema]
    providers: list[TranscriptionProviderConfigSchema]


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
        self._ws_init_timeout_sec = env.WS_INIT_TIMEOUT_SEC

        with open(env.PROVIDER_CONFIG_PATH, "r", encoding="utf-8") as file:
            self._provider_config = ProviderConfigFileAdapter.validate_json(
                file.read()
            )
