"""
Defines FasterWhisperContext for using faster whisper in WorkerProcess and WorkerPool
"""

from typing import Any, Literal

from faster_whisper import WhisperModel
from pydantic import BaseModel, TypeAdapter

from src.shared.logger import Logger
from src.shared.utils.worker_pool import JobContextInterface


class FasterWhisperContextConfig(BaseModel):
    """
    Provider configuration schema for FasterWhisperContext
    """

    model: str
    device: Literal["cuda"] | Literal["cpu"]


faster_whisper_context_config_adapter = TypeAdapter[FasterWhisperContextConfig](
    FasterWhisperContextConfig
)


class FasterWhisperContext(JobContextInterface[WhisperModel]):
    """
    Job context definition for using faster whisper in WorkerProcess and WorkerPool
    """

    def __init__(
        self,
        context_config: Any,
        max_instances: int,
        tags: list[str],
        negative_affinity: str | None,
        creation_cost: float,
    ):
        super().__init__(
            context_config,
            max_instances,
            tags,
            negative_affinity,
            creation_cost,
        )
        self._config = faster_whisper_context_config_adapter.validate_python(
            context_config
        )

    def create(self, log: Logger) -> WhisperModel:
        log.info(
            f"Creating {self._config.model} whisper model using device: {self._config.device}"
        )
        return WhisperModel(self._config.model, device=self._config.device)

    def destroy(self, log: Logger, context: WhisperModel) -> None:
        log.info("Destroying whisper model")
        if context.model and context.model.model_is_loaded:
            context.model.unload_model()
