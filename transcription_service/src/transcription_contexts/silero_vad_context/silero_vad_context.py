"""
Defines SileroVadContext for caching Silero VAD model in WorkerProcess
"""

from typing import Any, Callable, Tuple

import torch
from pydantic import BaseModel, TypeAdapter

from src.shared.logger import Logger
from src.shared.utils.worker_pool import JobContextInterface

SileroVadModelType = Tuple[Any, Callable]


class SileroVadContextConfig(BaseModel):
    """
    Configuration schema for SileroVadContext
    """

    repo_or_dir: str = "snakers4/silero-vad"
    model_name: str = "silero_vad"
    use_onnx: bool = False
    device: str = "cpu"


silero_vad_context_config_adapter = TypeAdapter(SileroVadContextConfig)


class SileroVadContext(JobContextInterface[SileroVadModelType]):
    """
    Job context definition for managing Silero VAD model lifecycle
    """

    # pylint: disable=duplicate-code
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
        self._config = silero_vad_context_config_adapter.validate_python(
            context_config
        )

    def create(self, log: Logger) -> SileroVadModelType:
        log.info(f"Loading Silero VAD model from {self._config.repo_or_dir}")

        torch.set_num_threads(1)

        try:
            model, utils = torch.hub.load(
                repo_or_dir=self._config.repo_or_dir,
                model=self._config.model_name,
                force_reload=False,
                onnx=self._config.use_onnx,
                trust_repo=True,
            )
            model.to(self._config.device)

            get_speech_timestamps = utils[0]

            log.info("Silero VAD model loaded successfully")
            return (model, get_speech_timestamps)

        except Exception as e:
            log.error(f"Failed to load Silero VAD: {e}")
            raise e

    def destroy(self, log: Logger, context: SileroVadModelType) -> None:
        log.info("Destroying Silero VAD context")
        model, _ = context
        if hasattr(model, "result"):
            pass
        del model
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
