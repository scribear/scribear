"""
Defines SileroVadContext for caching Silero VAD model in WorkerProcess
"""

from typing import Any, Callable, List, Tuple

import torch
from pydantic import BaseModel, TypeAdapter

from src.shared.logger import Logger
from src.shared.utils.silence_filter import SilenceFiltering
from src.shared.utils.worker_pool import JobContextInterface


class SileroVADService:
    """
    Service for VAD
    """

    def __init__(
        self,
        model: Any,
        get_speech_timestamps: Callable,
        sample_rate: int = 16000,
    ):
        self._model = model
        self._get_speech_timestamps = get_speech_timestamps
        self._sample_rate = sample_rate

    def detect_speech_ranges(
        self,
        buffer_samples: Any,
        threshold: float,
        neg_threshold: float | None = None,
    ) -> List[Tuple[int, int]]:
        """Detects speech segments in the audio buffer."""
        silence_filter = SilenceFiltering(
            buffer_samples,
            self._sample_rate,
            vad_model=self._model,
            get_speech_timestamps=self._get_speech_timestamps,
            threshold=threshold,
            neg_threshold=neg_threshold,
        )
        return silence_filter.voice_position_detection() or []


SileroVadModelType = SileroVADService


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
            return SileroVADService(model, get_speech_timestamps)

        except Exception as e:
            log.error(f"Failed to load Silero VAD: {e}")
            raise e

    def destroy(self, log: Logger, context: SileroVadModelType) -> None:
        log.info("Destroying Silero VAD context")
        if hasattr(context, "_model"):
            del context._model
        if hasattr(context, "_get_speech_timestamps"):
            del context._get_speech_timestamps
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
