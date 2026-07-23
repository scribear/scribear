import { Type } from 'typebox';
import type { Static } from 'typebox';

import { SNAPSHOT_ENVELOPE_PROPERTIES } from './snapshot-envelope.schema.js';

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
      'Fraction (0..1) of samples in the window within CLIP_EPSILON of full scale.',
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
 * One live session's audio-level telemetry as published to the backplane:
 * its latest `AudioLevelStats` plus VAD statistics (B2.2), the snapshot
 * envelope, and the session/room identifiers it was computed for.
 *
 * `roomUid` is nullable - same tolerance as everywhere else a caller may not
 * have supplied one (an older node-server peer, or a session opened before
 * the CONFIG message carried it). `transcriptionHost` identifies which
 * Transcription Service host's worker produced the reading, the same way
 * `TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA` identifies a provider-health snapshot's
 * source, and is required for the same reason: every host publishes under
 * its own `transcription_host_id` (config-derived, defaults to hostname),
 * so there is no case where a publish happens without one.
 *
 * `vadStats` is a required key whose *value* may be null - `AudioLevelStats`
 * and `VadStats` are produced by different mechanisms in the worker (a
 * persistent meter vs. a transient per-batch computation) and published
 * together in one write rather than two keys, per the same
 * keep-related-things-together reasoning `TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA`
 * already gives for a host's providers. A payload missing the key entirely
 * is still rejected: the publisher always writes it (as null when there is
 * nothing to report), so a missing key means the shape has drifted, not that
 * VAD was off.
 */
export const SESSION_AUDIO_SNAPSHOT_SCHEMA = Type.Object({
  ...AUDIO_LEVEL_STATS_SCHEMA.properties,
  ...SNAPSHOT_ENVELOPE_PROPERTIES,
  vadStats: Type.Union([VAD_STATS_SCHEMA, Type.Null()]),
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
