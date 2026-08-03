"""
Unit tests for the audio-telemetry stage graph's depth resolution
"""

from src.transcription_provider_interface import (
    STAGE_ASR_INPUT,
    STAGE_INGRESS,
    STAGE_VAD,
    AudioStageReading,
)
from src.webserver.features.telemetry import (
    resolve_stage_depths,
    resolve_stages,
)


def _reading(stage: str, *inputs: str) -> AudioStageReading:
    """Builds a reading carrying only what depth resolution looks at."""
    return AudioStageReading(
        stage=stage,
        label=stage,
        inputs=inputs,
        levels=None,
        vad=None,
        audio_seconds=None,
    )


def test_a_stage_with_no_inputs_is_a_source():
    """
    Audio enters the observed system at a stage that declares no inputs, and
    every published graph has at least one - the webserver's own ingress
    reading - so this is the case the whole resolution starts from.
    """
    # Arrange
    readings = [_reading(STAGE_INGRESS)]

    # Act
    depths = resolve_stage_depths(readings)

    # Assert
    assert depths == {STAGE_INGRESS: 1}


def test_a_declared_source_depth_continues_an_upstream_graph():
    """
    An arriving frame may declare that a peer already measured this audio, in
    which case ingress is not the source and must not claim depth 1 - a graph
    that restarted its numbering at every hop would put two different
    measurement points in the same column.
    """
    # Arrange
    readings = [
        _reading(STAGE_INGRESS),
        _reading(STAGE_ASR_INPUT, STAGE_INGRESS),
    ]

    # Act
    depths = resolve_stage_depths(readings, source_depth=3)

    # Assert
    assert depths == {STAGE_INGRESS: 3, STAGE_ASR_INPUT: 4}


def test_a_chain_gets_one_depth_per_hop():
    """
    The shipped topology (ingress -> asr_input -> vad) has to resolve to the
    three columns §12.3 tabulates, or the dashboard's "where did the audio
    stop" reading is against the wrong pipeline.
    """
    # Arrange
    readings = [
        _reading(STAGE_INGRESS),
        _reading(STAGE_ASR_INPUT, STAGE_INGRESS),
        _reading(STAGE_VAD, STAGE_ASR_INPUT),
    ]

    # Act
    depths = resolve_stage_depths(readings)

    # Assert
    assert depths == {STAGE_INGRESS: 1, STAGE_ASR_INPUT: 2, STAGE_VAD: 3}


def test_declaration_order_does_not_have_to_be_topological():
    """
    Readings arrive in whatever order a provider assembled them, and the
    webserver prepends its own - so requiring inputs to be declared before
    their consumers would make correctness depend on an ordering nobody
    guarantees.
    """
    # Arrange - deepest first, the exact reverse of resolution order.
    readings = [
        _reading(STAGE_VAD, STAGE_ASR_INPUT),
        _reading(STAGE_ASR_INPUT, STAGE_INGRESS),
        _reading(STAGE_INGRESS),
    ]

    # Act
    depths = resolve_stage_depths(readings)

    # Assert
    assert depths == {STAGE_INGRESS: 1, STAGE_ASR_INPUT: 2, STAGE_VAD: 3}


def test_a_stage_sits_one_past_its_deepest_input():
    """
    A stage fed by several points must sit past all of them, not past the
    first one resolved: a mixer fed by a source and by a detector two hops
    down would otherwise render upstream of what feeds it.
    """
    # Arrange
    readings = [
        _reading("mic"),
        _reading("gate", "mic"),
        _reading("asr", "mic", "gate"),
    ]

    # Act
    depths = resolve_stage_depths(readings)

    # Assert
    assert depths == {"mic": 1, "gate": 2, "asr": 3}


def test_two_detectors_in_front_of_two_asrs_stay_in_two_columns():
    """
    The topology §12.2 says a bare depth integer cannot express: two parallel
    branches must resolve by their own edges, not by how many stages exist.
    """
    # Arrange
    readings = [
        _reading(STAGE_INGRESS),
        _reading("vad_a", STAGE_INGRESS),
        _reading("vad_b", STAGE_INGRESS),
        _reading("asr_a", "vad_a"),
        _reading("asr_b", "vad_b"),
    ]

    # Act
    depths = resolve_stage_depths(readings)

    # Assert
    assert depths == {
        STAGE_INGRESS: 1,
        "vad_a": 2,
        "vad_b": 2,
        "asr_a": 3,
        "asr_b": 3,
    }


def test_an_input_naming_an_absent_stage_is_dropped():
    """
    A stage whose upstream reported nothing this snapshot must still be
    placed. Treating the dangling edge as unresolvable would let one
    occasional reporter suppress every stage downstream of it, which is the
    "incomplete graph, not a fatal one" rule of §12.2.
    """
    # Arrange - nothing in this snapshot reports `ingress`.
    readings = [_reading(STAGE_ASR_INPUT, STAGE_INGRESS)]

    # Act
    depths = resolve_stage_depths(readings)

    # Assert - the only input is gone, so this reading is the source.
    assert depths == {STAGE_ASR_INPUT: 1}


def test_only_the_absent_half_of_a_stages_inputs_is_dropped():
    """
    Dropping a dangling edge must not drop the edges beside it, or a stage
    that lost one upstream would collapse to a source and render in the wrong
    column despite still having a known input.
    """
    # Arrange
    readings = [
        _reading(STAGE_INGRESS),
        _reading(STAGE_VAD, STAGE_INGRESS, "a_stage_that_did_not_report"),
    ]

    # Act
    depths = resolve_stage_depths(readings)

    # Assert
    assert depths == {STAGE_INGRESS: 1, STAGE_VAD: 2}


def test_a_cycle_terminates_and_places_every_stage():
    """
    Two stages naming each other resolve nothing on any pass, so a fixpoint
    loop would spin forever. This is a telemetry path on the websocket's own
    thread: a provider's bad declaration must cost the dashboard a nonsense
    column, never the session.
    """
    # Arrange
    readings = [
        _reading(STAGE_INGRESS),
        _reading("loop_a", "loop_b"),
        _reading("loop_b", "loop_a"),
    ]

    # Act
    depths = resolve_stage_depths(readings)

    # Assert - placed past what did resolve, one per step in declaration
    # order, so the cycle is visible as a chain rather than one column.
    assert depths == {STAGE_INGRESS: 1, "loop_a": 2, "loop_b": 3}


def test_a_stage_naming_itself_terminates():
    """
    The degenerate cycle: a copy-paste in a provider's declaration. Its own id
    is present in the snapshot, so it is not dropped as an unknown input, and
    it can never resolve.
    """
    # Arrange
    readings = [_reading("self_fed", "self_fed")]

    # Act
    depths = resolve_stage_depths(readings)

    # Assert
    assert depths == {"self_fed": 1}


def test_no_readings_resolves_to_nothing():
    """
    A session that has measured nothing yet has no graph, and asking for one
    must not be an error - the caller decides that an empty result is not
    worth publishing.
    """
    # Arrange / Act
    depths = resolve_stage_depths([])

    # Assert
    assert not depths


def test_resolve_stages_pairs_each_reading_with_its_depth_in_order():
    """
    The published order is the caller's (ingress first, then the provider's
    stages) while depth is derived - so the pairing must not reorder anything
    on its way to the wire.
    """
    # Arrange
    readings = [
        _reading(STAGE_VAD, STAGE_ASR_INPUT),
        _reading(STAGE_INGRESS),
        _reading(STAGE_ASR_INPUT, STAGE_INGRESS),
    ]

    # Act
    resolved = resolve_stages(readings)

    # Assert
    assert [(stage.reading.stage, stage.depth) for stage in resolved] == [
        (STAGE_VAD, 3),
        (STAGE_INGRESS, 1),
        (STAGE_ASR_INPUT, 2),
    ]
    # The reading itself is carried through untouched, so a derived depth can
    # never be mistaken for something the provider asserted.
    assert resolved[1].reading is readings[1]
