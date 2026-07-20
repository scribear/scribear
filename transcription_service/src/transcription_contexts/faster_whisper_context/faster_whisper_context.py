"""
Defines FasterWhisperContext for using faster whisper in WorkerProcess and WorkerPool
"""

from typing import Any, Literal, Optional

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
    # Passed straight through to faster_whisper.WhisperModel; leave unset to
    # use faster-whisper's device-based default. Some CTranslate2 checkpoints
    # (e.g. CrisperWhisper's faster-whisper release) recommend "float32" for
    # accurate word timestamps.
    compute_type: Optional[str] = None


faster_whisper_context_config_adapter = TypeAdapter[FasterWhisperContextConfig](
    FasterWhisperContextConfig
)


class FasterWhisperContext(JobContextInterface[WhisperModel]):
    """
    Job context definition for using faster whisper in WorkerProcess and WorkerPool
    """

    def __init__(self, context_config: Any, tags: list[str]):
        super().__init__(tags)
        self._config = faster_whisper_context_config_adapter.validate_python(
            context_config
        )

    def create(self, log: Logger) -> WhisperModel:
        log.info(
            f"Creating {self._config.model} whisper model using device: {self._config.device}"
        )
        kwargs = {}
        if self._config.compute_type is not None:
            kwargs["compute_type"] = self._config.compute_type
        return WhisperModel(
            self._config.model, device=self._config.device, **kwargs
        )

    def destroy(self, log: Logger, context: WhisperModel) -> None:
        log.info("Destroying whisper model")
        if context.model and context.model.model_is_loaded:
            context.model.unload_model()
