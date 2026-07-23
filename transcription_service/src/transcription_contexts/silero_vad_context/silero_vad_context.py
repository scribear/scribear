"""
Defines SileroVadContext for caching Silero VAD model in WorkerProcess
"""

from typing import Any, Callable, List, Tuple

import torch
from pydantic import BaseModel, TypeAdapter

from src.shared.logger import Logger
from src.shared.utils.silence_filter import (
    IncrementalVadStream,
    SilenceFiltering,
)
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

    def create_stream(self) -> IncrementalVadStream:
        """
        Creates a per-session VAD stream over this shared model.

        Streaming callers should use this rather than detect_speech_ranges
        below: a stream scores each 512-sample window once and caches its
        probability, where detect_speech_ranges rescans the caller's entire
        buffer every time it is called. For a 30s buffer scored every 500ms
        that is 3.5ms per call against 69.7ms. See incremental_vad.py for the
        measurements, and for why moving this model to a GPU makes it slower
        rather than faster.

        Each stream owns its own Silero state, so several may share one model.
        They are not thread-safe with respect to one another: the state is
        swapped into the shared model for the duration of a call, which assumes
        the single-threaded worker process this runs in.
        """
        return IncrementalVadStream(
            self._model, self._get_speech_timestamps, self._sample_rate
        )

    def detect_speech_ranges(
        self,
        buffer_samples: Any,
        threshold: float,
        neg_threshold: float | None = None,
    ) -> List[Tuple[int, int]]:
        """
        Detects speech segments in the audio buffer, scoring all of it.

        One-shot path, kept for callers holding a complete recording. Streaming
        callers want create_stream() instead - see the note there.
        """
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
    # Leave this on "cpu". Silero is a streaming model whose 512-sample steps
    # are sequentially dependent, so a GPU cannot overlap them: measured on an
    # RTX 5070 Ti, a 30s buffer took 128.1ms on CUDA against 74.5ms on one CPU
    # thread, and 0.17ms per step against 0.08ms. Nor is the window size
    # adjustable to amortise the launch overhead - Silero v5 accepts 512
    # samples at 16kHz and rejects everything else.
    #
    # "cuda" is additionally broken today and fails quietly: SilenceFiltering
    # builds its input tensor on the CPU, so a GPU-resident model raises inside
    # TorchScript, the handler turns that into "no speech", and the job
    # transcribes nothing while looking healthy.
    #
    # incremental_vad.py has the full measurements, including the two batching
    # designs that could make a GPU worthwhile and what each would cost.
    device: str = "cpu"


silero_vad_context_config_adapter = TypeAdapter(SileroVadContextConfig)


class SileroVadContext(JobContextInterface[SileroVadModelType]):
    """
    Job context definition for managing Silero VAD model lifecycle
    """

    def __init__(self, context_config: Any, tags: list[str]):
        super().__init__(tags)
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
