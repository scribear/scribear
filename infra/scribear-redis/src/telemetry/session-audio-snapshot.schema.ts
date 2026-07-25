import { Type } from 'typebox';
import type { Static } from 'typebox';

import { SNAPSHOT_ENVELOPE_PROPERTIES } from './snapshot-envelope.schema.js';
import { parseSnapshot } from './snapshot-parse.js';
import type { SnapshotParseResult } from './snapshot-parse.js';

/**
 * Audio-level readout for one session's most recent metering window
 * (B2.1: RMS/peak dBFS, clipping, silence, noise floor).
 *
 * This restates, in TypeScript, the shape `AudioLevelStats` produces in
 * Transcription Service. The duplication is unavoidable - the Python service
 * shares no schema package with the Node apps - and is the reason this file
 * exists at all: with the shape written down once on this side, a field that
 * changes there fails validation at the reader instead of rendering as
 * `undefined` somewhere in the dashboard. `TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA`
 * restates `serialize_worker`'s shape for the same reason.
 */
export const AUDIO_LEVEL_STATS_SCHEMA = Type.Object({
  rmsDbfs: Type.Number({
    description: 'RMS level of the current metering window, in dBFS.',
  }),
  peakDbfs: Type.Number({
    description: 'Sample peak of the current metering window, in dBFS.',
  }),
  clippingPct: Type.Number({
    description:
      'Fraction (0..1) of samples in the window at or above 0.99 full scale in runs of at least 2 consecutive samples. The run requirement is what separates clipping from a waveform that merely touches full scale: a clean full-scale sine reaches 1.0 one isolated sample at a time and reads 0 here. Same rule and constants as the standalone meter page, so the two surfaces agree — see tools/audio-meter-crosscheck/.',
  }),
  silence: Type.Boolean({
    description:
      'True when the window’s RMS is at or below the configured silence threshold.',
  }),
  noiseFloorDbfs: Type.Number({
    description:
      '10th-percentile RMS across 1s sub-windows of the metering window - an ambient noise-floor estimate, distinct from momentary silence.',
  }),
});

/** @see {@link AUDIO_LEVEL_STATS_SCHEMA} */
export type AudioLevelStats = Static<typeof AUDIO_LEVEL_STATS_SCHEMA>;

/**
 * Per-batch voice-activity-detection statistics for one session (B2.2).
 *
 * This restates, in TypeScript, the shape `VadStats` produces in
 * Transcription Service - the same duplication-is-unavoidable reasoning
 * `AUDIO_LEVEL_STATS_SCHEMA` documents. Every field but `vadEnabled` is
 * nullable, because "not meaningful" is a real, distinct state here, not an
 * edge case: `vadEnabled: false` means VAD never ran, so the rest carries no
 * signal at all; `vadEnabled: true` with the rest present means VAD ran and
 * measured something (including a real, meaningful "found no speech" reading
 * of `speechActiveRatio: 0`); `segmentCount: 0` still nulls out
 * `meanSegmentDurationSec` (no segment to average) and `snrDb` (no signal
 * side to compare against noise) even while VAD is on.
 */
export const VAD_STATS_SCHEMA = Type.Object({
  vadEnabled: Type.Boolean({
    description:
      'Whether Silero VAD (config vad_detector) was enabled for this batch - always meaningful, even when every field below is null.',
  }),
  speechActiveRatio: Type.Union([Type.Number(), Type.Null()], {
    description:
      'Fraction (0..1) of the buffer VAD marked as speech. Null when vadEnabled is false.',
  }),
  segmentCount: Type.Union([Type.Integer(), Type.Null()], {
    description:
      'Number of speech segments VAD found in the buffer. Null when vadEnabled is false.',
  }),
  meanSegmentDurationSec: Type.Union([Type.Number(), Type.Null()], {
    description:
      'Mean speech-segment duration, in seconds. Null when vadEnabled is false, or when no segments were found (undefined, not zero).',
  }),
  speechToPauseRatio: Type.Union([Type.Number(), Type.Null()], {
    description:
      'speechActiveRatio / (1 - speechActiveRatio). Null when vadEnabled is false, or when speechActiveRatio is 1.0 (divide-by-zero guard at "all speech, no pause").',
  }),
  snrDb: Type.Union([Type.Number(), Type.Null()], {
    description:
      'Mean in-range RMS (dBFS) minus mean out-of-range RMS (dBFS), i.e. a VAD-gated signal-to-noise estimate. Null when vadEnabled is false, or when one side of the comparison has no samples (the buffer read as 0% or 100% speech).',
  }),
});

/** @see {@link VAD_STATS_SCHEMA} */
export type VadStats = Static<typeof VAD_STATS_SCHEMA>;

/**
 * One point in a session's audio pipeline where a measurement was taken, and
 * which points fed it.
 *
 * Audio telemetry is a directed graph of measurement points, not an ordered
 * list, because the question an operator actually asks - "where did the signal
 * get lost" - is a comparison across one edge. Each point declares only its own
 * immediate `inputs`, so a detector needs no knowledge of what fed the thing
 * that fed it, and a provider can add a point without any other point knowing.
 *
 * `inputs` rather than a bare depth integer, and this is the part that looks
 * like needless indirection until two providers exist: an integer gives levels
 * but not edges. Depth 2 says "draw this in column 2" and not which depth-1
 * point fed it, so two detectors in front of two ASRs render as four boxes in
 * two columns with no arrows, and a difference between adjacent numbers gets
 * read as a gap between points that are not adjacent in the graph.
 *
 * Stage ids are an open set. A point whose id no consumer has heard of is
 * published and rendered like any other - membership of some list is not what
 * makes the graph work, `inputs` is. That is also why `label` travels on the
 * wire instead of being mapped in the webapp: a provider inventing an id
 * supplies its display name in the same breath, so a new point never reaches an
 * operator as a raw identifier.
 *
 * `levels`, `vad` and `audioSeconds` are required keys whose *values* may be
 * null, the same fixed-shape reasoning the rest of this backplane follows: the
 * publisher always writes all three, as null when this point has nothing to
 * report, so a payload missing one means the shape has drifted rather than that
 * the point took no such measurement. An optional field would make those two
 * indistinguishable, which is exactly the silent `undefined` this file exists
 * to prevent.
 */
export const AUDIO_STAGE_SCHEMA = Type.Object({
  stage: Type.String({
    description:
      'Stable identifier for this measurement point, unique within a snapshot. It is the value other points name in their inputs, so it has to survive across publishes and across restarts of the process reporting it.',
  }),
  label: Type.String({
    description:
      'Operator-facing name, as the publisher wants this point shown. Carried per snapshot rather than mapped from the id by the reader, so a provider reporting a point no reader knows about still renders as words.',
  }),
  depth: Type.Integer({
    minimum: 1,
    description:
      'Distance from the nearest source: 1 for a point with no known input, otherwise max(depth(inputs)) + 1. Derived by the publisher and shipped denormalised so a reader can lay the pipeline out in columns without resolving the graph itself. Never below 1 - a 0 means depth resolution never ran, not that a point sits above the source.',
  }),
  inputs: Type.Array(Type.String(), {
    description:
      'Stage ids immediately upstream of this point; empty means this point is a source. An id naming a point absent from this snapshot is an upstream that reported nothing this batch - an incomplete graph, not a fatal one - and the publisher drops it from depth resolution rather than failing the publish.',
  }),
  levels: Type.Union([AUDIO_LEVEL_STATS_SCHEMA, Type.Null()], {
    description:
      'Null when this point counts throughput but runs no meter, which is a real configuration and not a degraded one: a provider that only decodes can still close the funnel by seconds alone, and fabricating levels to stay visible would be worse than reporting none.',
  }),
  vad: Type.Union([VAD_STATS_SCHEMA, Type.Null()], {
    description:
      'Null when this point runs no detector at all - distinct from a VadStats whose vadEnabled is false, which is a detector that is present and configured off. See VAD_STATS_SCHEMA: the two must not collapse into one visual state.',
  }),
  audioSeconds: Type.Union([Type.Number(), Type.Null()], {
    description:
      'Seconds of audio that have passed this point since the session opened - cumulative and monotonic, so two points are compared by subtracting one from the other. A rate would have to agree with the reader’s polling interval to be comparable between two points, and the two points do not share a clock; totals subtract cleanly across an edge whatever the sampling instants were. Null when this point cannot count it.',
  }),
});

/** One audio measurement point. @see {@link AUDIO_STAGE_SCHEMA} */
export type AudioStage = Static<typeof AUDIO_STAGE_SCHEMA>;

/**
 * One live session's audio telemetry as published to the backplane: every
 * measurement point the pipeline reported, the snapshot envelope, and the
 * session/room identifiers the reading was computed for.
 *
 * This replaced a single flat set of level fields plus one top-level
 * `vadStats`, a shape that could describe exactly one measurement point. With
 * only one point there was nothing to compare it against, so "audio is fine"
 * silently also asserted "the ASR is producing" and a provider that metered
 * nothing published no audio telemetry at all - which a reader cannot tell
 * apart from a microphone that is not sending. `stages` makes the pipeline the
 * unit and each measurement a point in it, so an absent measurement is a
 * missing point rather than a missing session.
 *
 * There is deliberately no dual-shape reader. Both sides ship from this repo
 * and the key's TTL is `AUDIO_STATS_TTL_MS`, so a rolling upgrade costs at most
 * one poll of missing audio telemetry, and a compatibility shim would be
 * permanent complexity bought for ten seconds. That only holds if the old shape
 * is *rejected* rather than partly accepted - see
 * {@link parseSessionAudioSnapshot}, which is what makes the mismatch a logged
 * drop instead of a dashboard full of `undefined`.
 *
 * `roomUid` is nullable - same tolerance as everywhere else a caller may not
 * have supplied one (an older node-server peer, or a session opened before
 * the CONFIG message carried it). `transcriptionHost` identifies which
 * Transcription Service host's worker produced the reading, the same way
 * `TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA` identifies a provider-health snapshot's
 * source, and is required for the same reason: every host publishes under
 * its own `transcription_host_id` (config-derived, defaults to hostname),
 * so there is no case where a publish happens without one.
 */
export const SESSION_AUDIO_SNAPSHOT_SCHEMA = Type.Object({
  ...SNAPSHOT_ENVELOPE_PROPERTIES,
  stages: Type.Array(AUDIO_STAGE_SCHEMA, {
    description:
      'Every measurement point that reported. Order carries no meaning - depth and inputs place a point in the pipeline - so a publisher may emit them in whatever order it walks its workers.',
  }),
  sessionUid: Type.String(),
  roomUid: Type.Union([Type.String(), Type.Null()]),
  transcriptionHost: Type.String({
    description: 'Identity of the publishing Transcription Service host.',
  }),
});

/**
 * Value of a session audio-stats snapshot key.
 * @see {@link SESSION_AUDIO_SNAPSHOT_SCHEMA}
 */
export type SessionAudioSnapshot = Static<typeof SESSION_AUDIO_SNAPSHOT_SCHEMA>;

/**
 * Validates one raw session-audio snapshot value read from the backplane.
 *
 * This is where the claim `AUDIO_LEVEL_STATS_SCHEMA` makes above - that a field
 * changing in the Python service fails validation at the reader instead of
 * rendering as `undefined` somewhere in the dashboard - stops being
 * aspirational. Restating the shape here is necessary for it and not
 * sufficient: a reader that parses JSON and casts gets precisely the silent
 * `undefined` the restatement was written to prevent, and no schema can stop
 * it from the other side of a package boundary. So the check ships from here,
 * beside the definition it enforces, rather than being re-implemented by each
 * consumer and drifting from the schema it is supposed to mirror.
 *
 * Never throws; a value that is not this snapshot is an expected input, not an
 * exception. The caller drops what does not validate, the same way it drops a
 * member whose key expired, so that one bad snapshot costs an operator one
 * session's audio telemetry rather than the whole fleet response - and logs
 * the returned errors, because a drop with no reason is how a shape drift hides
 * as an outage.
 */
export function parseSessionAudioSnapshot(
  raw: string,
): SnapshotParseResult<SessionAudioSnapshot> {
  return parseSnapshot(SESSION_AUDIO_SNAPSHOT_SCHEMA, raw);
}
