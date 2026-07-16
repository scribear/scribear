"""
Defines FasterWhisperContext for using faster whisper in WorkerProcess and WorkerPool
"""

from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, TypeAdapter

from src.shared.logger import Logger
from src.shared.utils.worker_pool import JobContextInterface

if TYPE_CHECKING:
    # Imported for typing only; the heavy faster_whisper import is deferred to
    # create() so importing this module (as unit-test collection does) stays
    # cheap and does not pull in faster_whisper / ctranslate2.
    from faster_whisper import WhisperModel


class FasterWhisperContextConfig(BaseModel):
    """
    Provider configuration schema for FasterWhisperContext
    """

    model: str
    device: Literal["cuda"] | Literal["cpu"]


faster_whisper_context_config_adapter = TypeAdapter[FasterWhisperContextConfig](
    FasterWhisperContextConfig
)


class FasterWhisperContext(JobContextInterface["WhisperModel"]):
    """
    Job context definition for using faster whisper in WorkerProcess and WorkerPool
    """

    def __init__(self, context_config: Any, tags: list[str]):
        super().__init__(tags)
        self._config = faster_whisper_context_config_adapter.validate_python(
            context_config
        )

    def create(self, log: Logger) -> "WhisperModel":
        log.info(
            f"Creating {self._config.model} whisper model using device: {self._config.device}"
        )
        # Imported lazily so importing this module stays cheap.
        from faster_whisper import (  # pylint: disable=import-outside-toplevel
            WhisperModel,
        )

        return WhisperModel(self._config.model, device=self._config.device)

    def destroy(self, log: Logger, context: "WhisperModel") -> None:
        log.info("Destroying whisper model")
        if context.model and context.model.model_is_loaded:
            context.model.unload_model()
