"""
Defines FasterWhisperContext for using faster whisper in WorkerProcess and WorkerPool
"""

from typing import Any, Literal, Optional

from faster_whisper import WhisperModel
from pydantic import BaseModel, TypeAdapter

from src.shared.logger import Logger
from src.shared.utils.worker_pool import JobContextInterface

# CTranslate2's own default when it is left to pick, and what the cpu device
# used before OMP_NUM_THREADS was pinned - so restoring it here reproduces the
# throughput that measured at parity with the uncapped image (19.33s against
# 17.97s for a 30s buffer) rather than inventing a new operating point.
#
# Deliberately not os.cpu_count(): a worker pool of N workers would then each
# claim every core. Raise it per context in provider_config.json when a
# deployment has the cores to spare.
DEFAULT_CPU_THREADS = 4


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
    # CTranslate2's intra-op thread count for CPU inference. Unset means
    # DEFAULT_CPU_THREADS on the cpu device and 1 on cuda - not
    # faster-whisper's own default, which reads OMP_NUM_THREADS, and the images
    # pin that to 1 to stop OpenBLAS spawning a spinning thread per core (see
    # Dockerfile_CPU). Sending that 1 on to CTranslate2 as well would serialise
    # CPU inference: 61.8s against 17.97s for a 30s buffer, measured. So the
    # value is chosen here rather than inherited, which is what keeps the
    # environment cap and CPU throughput independent of each other.
    #
    # Ignored by CTranslate2 on cuda, where the encoder and decoder run on the
    # GPU; passed anyway so the two devices take the same path.
    cpu_threads: Optional[int] = None


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

        cpu_threads = self._config.cpu_threads
        if cpu_threads is None:
            cpu_threads = (
                DEFAULT_CPU_THREADS if self._config.device == "cpu" else 1
            )
        log.info(f"Whisper CTranslate2 cpu_threads: {cpu_threads}")

        return WhisperModel(
            self._config.model,
            device=self._config.device,
            cpu_threads=cpu_threads,
            **kwargs,
        )

    def destroy(self, log: Logger, context: WhisperModel) -> None:
        log.info("Destroying whisper model")
        if context.model and context.model.model_is_loaded:
            context.model.unload_model()
