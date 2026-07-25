"""
Defines WorkerPool job for DebugProvider that returns number of seconds of audio received
"""

from dataclasses import dataclass

from src.shared.logger import Logger
from src.shared.utils.audio_decoder import AudioDecoder, TargetFormat
from src.shared.utils.worker_pool import JobInterface
from src.transcription_provider_interface import (
    STAGE_ASR_INPUT,
    STAGE_INGRESS,
    AudioStageReading,
    TranscriptionClientError,
)

from .debug_session_config import DebugSessionConfig


@dataclass(frozen=True)
class DebugJobResult:
    """
    What one DebugProviderJob execution produces.

    The job used to return a bare float, which left it nowhere to put audio
    telemetry - and a provider that reports none publishes no audio snapshot at
    all, which the dashboard reads as "no audio reaching the ASR". It is still
    the session, not the job, that builds the TranscriptionResult (only the
    session sees the execution timing that goes into the debug transcript), so
    the job returns both halves and the session assembles them.

    Holds plain scalars and AudioStageReadings only, so it stays picklable
    across the worker -> main-process queue boundary it crosses.
    """

    #: Seconds of audio decoded by this execution alone - the number the debug
    #: transcript reports, so it is per-batch, not the cumulative total the
    #: stage reading below carries.
    seconds_decoded: float
    audio_stages: tuple[AudioStageReading, ...]


class DebugProviderJob(JobInterface[tuple, bytes, DebugJobResult, None]):
    """
    WorkerPool job definition for DebugProvider
    Decodes audio chunks and returns number of seconds of audio received
    """

    def __init__(self, config: DebugSessionConfig):
        self._sample_rate = config.sample_rate
        self._decoder = AudioDecoder(
            config.sample_rate, config.num_channels, TargetFormat.FLOAT_32
        )

        # Cumulative across the session, unlike the per-batch figure the debug
        # transcript prints: the stage graph compares totals across an edge by
        # subtraction, which only works if both ends count from session start.
        self._decoded_audio_seconds = 0.0

    def process_batch(
        self, log: Logger, contexts: tuple, batch: list[bytes]
    ) -> DebugJobResult:
        samples_decoded = 0
        for chunk in batch:
            try:
                segments = self._decoder.decode(chunk)
            except ValueError as e:
                raise TranscriptionClientError(str(e)) from e
            samples_decoded += len(segments)

        seconds_decoded = samples_decoded / self._sample_rate
        self._decoded_audio_seconds += seconds_decoded

        return DebugJobResult(
            seconds_decoded=seconds_decoded,
            audio_stages=(
                AudioStageReading(
                    stage=STAGE_ASR_INPUT,
                    label="ASR input (worker decode)",
                    inputs=(STAGE_INGRESS,),
                    # Throughput only: this provider runs no meter and no
                    # detector, and reporting either as a zero-valued reading
                    # would claim a measurement it never took. Seconds alone
                    # still close the funnel - they are what shows whether the
                    # audio the websocket accepted reached the worker.
                    levels=None,
                    vad=None,
                    audio_seconds=self._decoded_audio_seconds,
                ),
            ),
        )

    def update_config(self, log: Logger, contexts: tuple, config: None) -> None:
        raise TranscriptionClientError("On the fly config update not supported")
