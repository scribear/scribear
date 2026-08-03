/**
 * The two devices' tunable parameters, their bounds, and their defaults.
 *
 * Kept in the library rather than in the service that exposes them because the
 * streaming engine is what actually has to honour a bound: clamping at the HTTP
 * edge alone would leave the engine's behaviour undefined for anything that
 * reached it another way (a test, a future caller, a schema that drifted). The
 * service's typebox schema states the same numbers for the benefit of callers;
 * {@link clampGoodParams} and {@link clampFaultParams} are what enforce them.
 */

/** Catalog id of a source recording. Paths are the service's business. */
export type ClipId = 'harvard' | 'apollo' | 'longform';
export const CLIP_IDS: readonly ClipId[] = ['harvard', 'apollo', 'longform'];

/** Noise floor character. `none` skips the generator entirely. */
export type NoiseType = 'none' | 'white' | 'brown';
export const NOISE_TYPES: readonly NoiseType[] = ['none', 'white', 'brown'];

/**
 * The five offered noise floors, in dBFS.
 *
 * Fixed levels rather than a slider, per the brief. -60 is a clean studio
 * floor; -20 is loud enough to cost words, which is the point of having the
 * top of the range at all.
 */
export const NOISE_DB_LEVELS = [-60, -50, -40, -30, -20] as const;
export type NoiseDb = (typeof NOISE_DB_LEVELS)[number];

/** Device 1: good speech, with level and noise floor an operator can move. */
export interface GoodParams {
  clip: ClipId;
  /**
   * Level trim in dB.
   *
   * The range spans too-soft to too-loud on purpose. -40 dB puts a normal
   * fixture below the ingress meter's silence floor (0.01 linear RMS is
   * -40 dBFS), and +20 dB drives it into hard clipping at the rail. Both ends
   * are meant to be reachable; that is what the parameter is for.
   */
  gainDb: number;
  noiseType: NoiseType;
  noiseDb: NoiseDb;
}

/**
 * Device 2: one knob per fault, each independently settable so an operator can
 * reproduce a single report or stack several.
 *
 * All default to zero, so a `fault` device started with no parameters streams
 * clean audio and the operator turns on exactly the fault they came to see.
 */
export interface FaultParams {
  /**
   * Percentage of samples driven into full-scale clipping. See
   * {@link hardClipToRail} for why this is a *target share of clipped samples*
   * rather than a threshold.
   */
  clipPct: number;
  /** Probability (%) that a chunk is sent twice, reusing its `chunkId`. */
  stutterPct: number;
  /** Probability (%) that a chunk is skipped, leaving a gap in the audio. */
  dropPct: number;
  /**
   * Send-rate multiple. Changes the *schedule only* — never the audio — so it
   * trips the transcription service's faster-than-realtime rejection and
   * nothing else.
   */
  speedup: number;
  /** Probability (%) that a chunk's audio is replaced with digital silence. */
  silencePct: number;
  /** DC bias added to the waveform, as a fraction of full scale. */
  dcOffset: number;
  /** Probability (%) that the encoded SAFP frame is corrupted past its CRC. */
  corruptPct: number;
  /** Probability (%) that the chunk's WAV header declares the wrong rate. */
  badHeaderPct: number;
  /** Offset written into the frame's `sentAt` field, in milliseconds. */
  clockSkewMs: number;
}

export const GOOD_PARAM_DEFAULTS: GoodParams = {
  clip: 'harvard',
  gainDb: 0,
  noiseType: 'none',
  noiseDb: -60,
};

export const FAULT_PARAM_DEFAULTS: FaultParams = {
  clipPct: 0,
  stutterPct: 0,
  dropPct: 0,
  speedup: 1,
  silencePct: 0,
  dcOffset: 0,
  corruptPct: 0,
  badHeaderPct: 0,
  clockSkewMs: 0,
};

export const GAIN_DB_MIN = -40;
export const GAIN_DB_MAX = 20;
export const SPEEDUP_MIN = 1;
export const SPEEDUP_MAX = 3;
export const CLOCK_SKEW_MS_MIN = -5_000;
export const CLOCK_SKEW_MS_MAX = 5_000;

/**
 * @param fallback Used for a non-finite input. NaN survives every comparison,
 *   so `Math.min`/`Math.max` would pass it straight through into a gain factor
 *   and turn the chunk into silence; and falling back to `min` would be wrong
 *   for a knob whose range straddles zero, where the safe value is the default
 *   rather than the bottom of the range.
 */
function clampNumber(
  value: number,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Snaps an arbitrary number to the nearest offered noise floor. */
export function nearestNoiseDb(value: number): NoiseDb {
  let best: NoiseDb = NOISE_DB_LEVELS[0];
  for (const level of NOISE_DB_LEVELS) {
    if (Math.abs(level - value) < Math.abs(best - value)) best = level;
  }
  return best;
}

/** Brings a partially-specified `good` parameter set into range. */
export function clampGoodParams(params: Partial<GoodParams>): GoodParams {
  const merged = { ...GOOD_PARAM_DEFAULTS, ...params };
  return {
    clip: CLIP_IDS.includes(merged.clip)
      ? merged.clip
      : GOOD_PARAM_DEFAULTS.clip,
    gainDb: clampNumber(merged.gainDb, GAIN_DB_MIN, GAIN_DB_MAX, 0),
    noiseType: NOISE_TYPES.includes(merged.noiseType)
      ? merged.noiseType
      : GOOD_PARAM_DEFAULTS.noiseType,
    noiseDb: nearestNoiseDb(merged.noiseDb),
  };
}

/** Brings a partially-specified `fault` parameter set into range. */
export function clampFaultParams(params: Partial<FaultParams>): FaultParams {
  const merged = { ...FAULT_PARAM_DEFAULTS, ...params };
  return {
    clipPct: clampNumber(merged.clipPct, 0, 100, 0),
    stutterPct: clampNumber(merged.stutterPct, 0, 100, 0),
    dropPct: clampNumber(merged.dropPct, 0, 100, 0),
    speedup: clampNumber(merged.speedup, SPEEDUP_MIN, SPEEDUP_MAX, 1),
    silencePct: clampNumber(merged.silencePct, 0, 100, 0),
    dcOffset: clampNumber(merged.dcOffset, 0, 1, 0),
    corruptPct: clampNumber(merged.corruptPct, 0, 100, 0),
    badHeaderPct: clampNumber(merged.badHeaderPct, 0, 100, 0),
    clockSkewMs: clampNumber(
      merged.clockSkewMs,
      CLOCK_SKEW_MS_MIN,
      CLOCK_SKEW_MS_MAX,
      0,
    ),
  };
}
