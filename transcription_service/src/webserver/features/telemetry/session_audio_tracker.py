"""
Defines SessionAudioTracker, which holds one session's audio-telemetry graph:
the ingress measurement the webserver takes itself, plus whatever its provider
last reported (plan §12.2/§12.3)
"""

import io
from typing import Sequence

import numpy as np
import soundfile as sf

from src.shared.logger import Logger
from src.shared.utils.audio_meter import AudioMeter
from src.transcription_provider_interface import (
    STAGE_INGRESS,
    AudioStageReading,
)

from .audio_stage_graph import ResolvedAudioStage, resolve_stages

#: Operator-facing name for the ingress stage. Lives here rather than in
#: `audio_stages` because the label belongs to whoever takes the measurement,
#: not to the id: a future node-server that meters upstream will name its own
#: stage, and nothing should be able to relabel this one from a distance.
INGRESS_LABEL = "Source ingress"


class SessionAudioTracker:
    """
    Accumulates one websocket session's audio telemetry (plan §12.3)

    **Why the webserver meters at all.** Metering used to be a provider's job,
    which made it absent for every provider that did not bother - so a healthy
    `lumen_granite` or `debug` deployment published no audio snapshot and the
    dashboard read that as "no audio reaching ASR" (§12.1). Ingress is the one
    point every session passes through regardless of which ASR is configured,
    and - by D1 - the one point a stalled model cannot affect, so it is
    measured here and contributed to every snapshot.

    **Nothing here may raise.** Every method is on the websocket's own
    codepath, one call per inbound chunk; a telemetry failure that propagated
    would drop the session's audio, which is a far worse outcome than a gap in
    a dashboard. Undecodable chunks are counted as unmetered and dropped.

    Lives beside the publisher rather than in the stream controller so the
    controller keeps holding protocol concerns only, and so the accumulation
    rules are testable without a websocket.
    """

    def __init__(self, logger: Logger, silence_threshold: float = 0.01):
        """
        Args:
            logger              - Logger for this connection
            silence_threshold    - Linear RMS threshold below which the ingress
                                     window reads as silence, from
                                     AUDIO_SILENCE_THRESHOLD. Configurable
                                     because the equivalent knob for whisper's
                                     own meter lives in provider config, and
                                     the ingress meter has no provider config
                                     to read.
        """
        self._logger = logger
        self._silence_threshold = silence_threshold

        # Created on the first chunk that decodes, not here: an AudioMeter
        # needs a sample rate to size its window, and the webserver never sees
        # provider config - the rate is only knowable from a chunk's own
        # container header (see `meter_chunk`).
        self._meter: AudioMeter | None = None
        self._ingress_seconds = 0.0
        self._source_depth = 1
        self._logged_decode_failure = False

        # Keyed by stage id, so a stage that reports only occasionally keeps
        # its last value instead of vanishing from the graph on every batch
        # that did not mention it. Insertion-ordered, so the order a provider
        # first declared its stages in is the order they publish in.
        self._provider_stages: dict[str, AudioStageReading] = {}

    def meter_chunk(
        self, audio: bytes, declared_stage_depth: int | None = None
    ) -> bool:
        """
        Feeds one inbound chunk's audio into the ingress meter

        Args:
            audio                  - Raw container bytes exactly as they
                                       arrived, before any provider has seen
                                       them
            declared_stage_depth    - Depth the sending peer claims to have
                                       measured at, if the frame declared one.
                                       Ingress then continues the graph from
                                       there instead of starting it.

        Returns:
            True if the chunk was metered. False means it did not decode, and
            is deliberately not an error: the audio still goes to the provider,
            whose decoder validates it properly and reports the failure.
        """
        if declared_stage_depth is not None:
            # An upstream peer already measured; ingress sits one past it. The
            # frame carries a depth and not a stage id, so ingress cannot name
            # that peer as an input - which is exactly why source_depth is
            # settable rather than derived from `inputs` here.
            self._source_depth = declared_stage_depth + 1

        try:
            # Read the header directly rather than through AudioDecoder:
            # AudioDecoder validates the rate and channel count against a
            # configured expectation, and the webserver has no provider config
            # to expect anything from. The rate the chunk itself declares is
            # both what this meter needs and the only thing available here.
            with sf.SoundFile(io.BytesIO(audio), "r") as audio_file:
                sample_rate = audio_file.samplerate
                samples = audio_file.read(dtype="float32")
        except Exception as error:  # pylint: disable=broad-exception-caught
            # Broad on purpose: a malformed container can surface as
            # LibsndfileError, but also as a RuntimeError or ValueError from
            # deeper in libsndfile, and none of them may reach the websocket.
            self._log_decode_failure(error)
            return False

        if sample_rate <= 0 or len(samples) == 0:
            return False

        # Multi-channel chunks are downmixed to mono. Levels for a graph like
        # this answer "is the source producing usable audio", which is a
        # question about the programme as a whole; per-channel readouts would
        # need a per-channel wire shape and a UI to match. The cost is that
        # two out-of-phase channels read quieter than either one does, which no
        # single-number readout can avoid.
        if samples.ndim > 1:
            samples = np.mean(samples, axis=1, dtype=np.float32)

        if self._meter is None:
            self._meter = AudioMeter(
                sample_rate=sample_rate,
                silence_threshold=self._silence_threshold,
            )

        self._meter.append(samples)
        # From this chunk's own rate rather than the meter's, so the cumulative
        # total stays truthful even if a peer changed rate mid-session. The
        # meter keeps the first rate it saw: its window would otherwise be
        # rebuilt (losing the history the readout is computed over) for a
        # session that is already failing at the provider's decoder, which
        # rejects any chunk disagreeing with the configured rate.
        self._ingress_seconds += len(samples) / sample_rate
        return True

    def record_provider_stages(
        self, stages: Sequence[AudioStageReading]
    ) -> None:
        """
        Merges the stages a provider just reported into this session's graph

        Merged by stage id rather than replacing the set wholesale: a detector
        that only reports when it has something to say would otherwise appear
        and disappear from the dashboard between batches, and an edge whose far
        end keeps vanishing cannot be compared.

        Args:
            stages - The reading(s) on the result that just arrived. Empty is
                       normal - a provider that measures nothing still gets an
                       ingress stage published for it.
        """
        for stage in stages:
            self._provider_stages[stage.stage] = stage

    def resolved_stages(self) -> tuple[ResolvedAudioStage, ...]:
        """
        Builds the stage list to publish, with depths resolved

        **Costs an `AudioMeter.snapshot()`** - ~218 us over a 10 s window,
        against ~29 us to meter a chunk - so callers must only reach this when
        a publish would actually happen (§12.9). Nothing here memoises it: a
        cached snapshot would be a second freshness contract to keep in step
        with the publisher's throttle, which already decides how often the
        cost is paid.

        Returns:
            Ingress first (when anything has been metered), then the provider's
            stages in the order they were first declared, each carrying the
            depth derived from the graph. Empty when nothing at all has been
            measured yet, which is a real "no telemetry" and not a zero.
        """
        readings: list[AudioStageReading] = []

        if self._meter is not None:
            readings.append(
                AudioStageReading(
                    stage=STAGE_INGRESS,
                    label=INGRESS_LABEL,
                    # No inputs even when a peer declared a depth: the frame
                    # names no stage id to point at, so the edge would be to
                    # something the reader cannot look up.
                    inputs=(),
                    levels=self._meter.snapshot(),
                    vad=None,
                    audio_seconds=self._ingress_seconds,
                )
            )

        readings.extend(self._provider_stages.values())
        return resolve_stages(readings, self._source_depth)

    def _log_decode_failure(self, error: Exception) -> None:
        """
        Logs the first undecodable chunk of a session and no others

        Chunks arrive ~10/s, and a session whose format the meter cannot read
        will fail on every one of them - so logging per chunk would bury every
        other line in the log for the sake of one fact that does not change.
        """
        if self._logged_decode_failure:
            return
        self._logged_decode_failure = True
        self._logger.debug(
            "Ingress audio metering could not decode a chunk; audio telemetry "
            "for this session will report provider stages only",
            context={"error": str(error)},
        )
