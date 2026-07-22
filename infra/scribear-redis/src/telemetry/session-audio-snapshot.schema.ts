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
 * One live session's audio-level telemetry as published to the backplane:
 * its latest `AudioLevelStats` plus the snapshot envelope and the
 * session/room identifiers it was computed for.
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
  ...AUDIO_LEVEL_STATS_SCHEMA.properties,
  ...SNAPSHOT_ENVELOPE_PROPERTIES,
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
