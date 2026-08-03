"""
Resolves the depth of each audio-telemetry measurement point from the inputs
it declared (plan §12.2)
"""

from dataclasses import dataclass
from typing import Sequence

from src.transcription_provider_interface import AudioStageReading


@dataclass(frozen=True)
class ResolvedAudioStage:
    """
    An `AudioStageReading` paired with the depth derived for it

    Depth is denormalised onto the published payload rather than left for a
    reader to recompute: the reader would need the whole graph and the same
    tie-breaking rules to arrive at the same columns, and a dashboard that
    disagreed with the service about which column a stage sits in is worse
    than one that never draws the graph. The reading itself stays untouched so
    the derived number can never be mistaken for something a provider
    asserted.
    """

    reading: AudioStageReading
    depth: int


def resolve_stage_depths(
    readings: Sequence[AudioStageReading], source_depth: int = 1
) -> dict[str, int]:
    """
    Derives a depth for every reading from the `inputs` each one declares

    A worker declares only its own immediate input, so the pipeline's shape is
    never written down anywhere - it is recovered here, at publish time, from
    the edges the readings carry. Rules, in order:

      - a reading with no *known* inputs is a source and sits at
        `source_depth`;
      - otherwise it sits at `max(depth(inputs)) + 1`;
      - an input naming a stage that is not in `readings` is dropped from
        consideration rather than treated as unresolvable. The upstream point
        simply reported nothing this batch (a provider whose detector only
        speaks up occasionally, or a worker whose result has not come back
        yet), which makes the graph incomplete, not broken - and a stage
        dropped for that reason must still be placed, or an occasional
        reporter would take the whole snapshot down with it;
      - a stage whose known inputs are not all placed yet waits for a later
        pass, so declaration order does not have to be topological.

    **This is a telemetry path, so it must not hang or raise.** A provider
    that declares a cycle - directly, or by two stages naming each other -
    would leave a pass resolving nothing, forever. When that happens the
    remaining stages are placed after everything already resolved, one per
    step in declaration order, and the loop stops. Spreading them rather than
    stacking them on one depth is what makes "declaration order" mean
    anything, and it keeps a cycle legible on the dashboard (a chain the
    operator can see is wrong) instead of collapsing it into a single column
    that looks deliberate.

    Args:
        readings        - The stage readings making up this snapshot. Duplicate
                            stage ids resolve to a single entry; callers merge
                            by id before this point.
        source_depth     - Depth given to a reading with no known inputs.
                            `1` unless the arriving audio frame declared a
                            depth of its own, in which case the graph
                            continues from there.

    Returns:
        stage id -> depth, for every id present in `readings`.
    """
    known = {reading.stage for reading in readings}
    depths: dict[str, int] = {}

    # Inputs naming a stage absent from this snapshot are discarded once, up
    # front, so the fixpoint loop below only ever sees edges it can settle.
    pending = [
        (
            reading.stage,
            tuple(stage for stage in reading.inputs if stage in known),
        )
        for reading in readings
    ]

    while pending:
        unresolved: list[tuple[str, tuple[str, ...]]] = []
        for stage, inputs in pending:
            if not inputs:
                depths[stage] = source_depth
            elif all(upstream in depths for upstream in inputs):
                depths[stage] = max(depths[upstream] for upstream in inputs) + 1
            else:
                unresolved.append((stage, inputs))

        if len(unresolved) == len(pending):
            # No progress: what is left is a cycle. Place it and stop.
            next_depth = max(depths.values(), default=source_depth - 1) + 1
            for stage, _ in unresolved:
                depths[stage] = next_depth
                next_depth += 1
            break

        pending = unresolved

    return depths


def resolve_stages(
    readings: Sequence[AudioStageReading], source_depth: int = 1
) -> tuple[ResolvedAudioStage, ...]:
    """
    Pairs each reading with its resolved depth, preserving declaration order

    Order is preserved rather than sorted by depth: the caller declares the
    order it wants read (ingress first, then whatever the provider reported),
    and a reader that wants to group by depth has the depth to do it with.

    Args:
        readings        - The stage readings making up this snapshot
        source_depth     - Depth given to a reading with no known inputs

    Returns:
        One ResolvedAudioStage per reading, in the order given.
    """
    depths = resolve_stage_depths(readings, source_depth)
    return tuple(
        ResolvedAudioStage(reading=reading, depth=depths[reading.stage])
        for reading in readings
    )
