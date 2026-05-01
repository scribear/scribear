"""
Defines PyannoteDiarizationContext for speaker diarization in WorkerPool
"""

import os
from dataclasses import dataclass
from typing import Any, Literal

import numpy as np
from pydantic import BaseModel, TypeAdapter

from src.shared.logger import Logger
from src.shared.utils.worker_pool import JobContextInterface


@dataclass
class SpeakerDiarizationSegment:
    """
    Speaker label active over a time range relative to provided audio.
    """

    start: float
    end: float
    speaker: str


class PyannoteDiarizationService:
    """
    Thin wrapper around pyannote Pipeline with a repo-local return shape.
    """

    def __init__(self, pipeline: Any):
        self._pipeline = pipeline

    def diarize(
        self,
        samples: np.ndarray,
        sample_rate: int,
        min_speakers: int | None = None,
        max_speakers: int | None = None,
    ) -> list[SpeakerDiarizationSegment]:
        """
        Run speaker diarization over mono float audio samples.
        """
        import torch

        waveform = torch.from_numpy(
            np.ascontiguousarray(samples, dtype=np.float32)
        ).unsqueeze(0)

        kwargs: dict[str, int] = {}
        if min_speakers is not None:
            kwargs["min_speakers"] = min_speakers
        if max_speakers is not None:
            kwargs["max_speakers"] = max_speakers

        output = self._pipeline(
            {"waveform": waveform, "sample_rate": sample_rate}, **kwargs
        )

        diarization = getattr(
            output,
            "exclusive_speaker_diarization",
            getattr(output, "speaker_diarization", output),
        )

        return self._extract_segments(diarization)

    def _extract_segments(
        self, diarization: Any
    ) -> list[SpeakerDiarizationSegment]:
        """
        Convert pyannote diarization output variants into simple segments.
        """
        if hasattr(diarization, "itertracks"):
            return [
                SpeakerDiarizationSegment(
                    start=float(turn.start),
                    end=float(turn.end),
                    speaker=str(speaker),
                )
                for turn, _, speaker in diarization.itertracks(yield_label=True)
            ]

        segments: list[SpeakerDiarizationSegment] = []
        for item in diarization:
            if len(item) == 2:
                turn, speaker = item
            else:
                turn, _, speaker = item
            segments.append(
                SpeakerDiarizationSegment(
                    start=float(turn.start),
                    end=float(turn.end),
                    speaker=str(speaker),
                )
            )
        return segments


PyannoteDiarizationModelType = PyannoteDiarizationService


class PyannoteDiarizationContextConfig(BaseModel):
    """
    Configuration schema for PyannoteDiarizationContext
    """

    model: str = "pyannote/speaker-diarization-community-1"
    device: Literal["cuda"] | Literal["cpu"] = "cpu"
    token_env_var: str = "HUGGINGFACE_ACCESS_TOKEN"


pyannote_diarization_context_config_adapter = TypeAdapter(
    PyannoteDiarizationContextConfig
)


class PyannoteDiarizationContext(
    JobContextInterface[PyannoteDiarizationModelType]
):
    """
    Job context definition for managing a pyannote diarization pipeline.
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
        self._config = (
            pyannote_diarization_context_config_adapter.validate_python(
                context_config
            )
        )

    def create(self, log: Logger) -> PyannoteDiarizationModelType:
        from pyannote.audio import Pipeline

        token = os.environ.get(self._config.token_env_var)
        if not token:
            raise RuntimeError(
                f"Environment variable '{self._config.token_env_var}' must be "
                "set to load pyannote diarization model"
            )

        log.info(
            f"Creating {self._config.model} diarization model using device: "
            f"{self._config.device}"
        )
        pipeline = Pipeline.from_pretrained(self._config.model, token=token)

        if self._config.device == "cuda":
            import torch

            pipeline.to(torch.device("cuda"))

        return PyannoteDiarizationService(pipeline)

    def destroy(
        self, log: Logger, context: PyannoteDiarizationModelType
    ) -> None:
        log.info("Destroying pyannote diarization model")
        if hasattr(context, "_pipeline"):
            del context._pipeline
