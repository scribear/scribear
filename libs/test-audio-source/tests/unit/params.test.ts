import { describe, expect } from 'vitest';

import {
  CLOCK_SKEW_MS_MAX,
  CLOCK_SKEW_MS_MIN,
  FAULT_PARAM_DEFAULTS,
  GAIN_DB_MAX,
  GAIN_DB_MIN,
  GOOD_PARAM_DEFAULTS,
  NOISE_DB_LEVELS,
  SPEEDUP_MAX,
  SPEEDUP_MIN,
  clampFaultParams,
  clampGoodParams,
  nearestNoiseDb,
} from '#src/params.js';

describe('params', () => {
  describe('nearestNoiseDb', (it) => {
    it('returns each offered level unchanged', () => {
      // Arrange — the five levels are the whole domain of the knob; snapping
      // one of them to a different one would silently retune an operator's
      // request.

      // Act / Assert
      for (const level of NOISE_DB_LEVELS) {
        expect(nearestNoiseDb(level)).toBe(level);
      }
    });

    it('snaps an in-between value to the nearer level', () => {
      // Act / Assert
      expect(nearestNoiseDb(-37)).toBe(-40);
      expect(nearestNoiseDb(-43)).toBe(-40);
      expect(nearestNoiseDb(-21)).toBe(-20);
    });

    it('resolves an exact tie downward, to the quieter floor', () => {
      // Arrange — -55 is equidistant from -60 and -50. Resolving to the
      // quieter one is the conservative direction for a knob that costs words
      // as it rises, and it has to be pinned somewhere: the implementation
      // keeps the first level it saw, and this test is what says so.

      // Act / Assert
      expect(nearestNoiseDb(-55)).toBe(-60);
      expect(nearestNoiseDb(-45)).toBe(-50);
      expect(nearestNoiseDb(-25)).toBe(-30);
    });

    it('clamps beyond either end of the range', () => {
      // Act / Assert
      expect(nearestNoiseDb(-500)).toBe(-60);
      expect(nearestNoiseDb(200)).toBe(-20);
    });

    it('falls back to the default floor for a non-finite request', () => {
      // Arrange — every comparison against NaN is false, so the scan keeps its
      // starting level. That has to be the default rather than an arbitrary
      // one, and it is only the default because -60 leads the list.

      // Act / Assert
      expect(nearestNoiseDb(Number.NaN)).toBe(GOOD_PARAM_DEFAULTS.noiseDb);
    });
  });

  describe('clampGoodParams', (it) => {
    it('fills every unset field from the defaults', () => {
      // Act / Assert — a device started with no parameters must stream clean,
      // unmodified speech.
      expect(clampGoodParams({})).toEqual(GOOD_PARAM_DEFAULTS);
    });

    it('holds gainDb to the range the engine is specified over', () => {
      // Arrange — the bounds are enforced here rather than only at the HTTP
      // edge, because the engine is what has to honour them for any caller.

      // Act / Assert
      expect(clampGoodParams({ gainDb: 999 }).gainDb).toBe(GAIN_DB_MAX);
      expect(clampGoodParams({ gainDb: -999 }).gainDb).toBe(GAIN_DB_MIN);
      expect(clampGoodParams({ gainDb: -6.5 }).gainDb).toBe(-6.5);
    });

    it('falls back to 0 dB rather than the floor for a non-finite gain', () => {
      // Arrange — NaN survives Math.min/Math.max, so an unguarded clamp would
      // pass it into `dbToLinear` and turn the whole chunk into silence.
      // Falling back to the bottom of the range would be almost as wrong: -40
      // dB is itself a fault setting.

      // Act / Assert
      expect(clampGoodParams({ gainDb: Number.NaN }).gainDb).toBe(0);
      expect(clampGoodParams({ gainDb: Number.POSITIVE_INFINITY }).gainDb).toBe(
        0,
      );
    });

    it('rejects a clip id or noise type that is not in the catalog', () => {
      // Arrange — these arrive as strings from an HTTP body, so a drifted
      // schema could deliver anything.
      const bogus = {
        clip: 'not-a-clip',
        noiseType: 'pink',
      } as unknown as Parameters<typeof clampGoodParams>[0];

      // Act
      const clamped = clampGoodParams(bogus);

      // Assert
      expect(clamped.clip).toBe(GOOD_PARAM_DEFAULTS.clip);
      expect(clamped.noiseType).toBe(GOOD_PARAM_DEFAULTS.noiseType);
    });

    it('snaps an arbitrary noise floor onto the offered levels', () => {
      // Act / Assert
      expect(clampGoodParams({ noiseDb: -33 as never }).noiseDb).toBe(-30);
    });
  });

  describe('clampFaultParams', (it) => {
    it('leaves a device started with no parameters entirely clean', () => {
      // Arrange — all-zero defaults are what make the fault device usable: the
      // operator turns on exactly the fault they came to see.

      // Act / Assert
      expect(clampFaultParams({})).toEqual(FAULT_PARAM_DEFAULTS);
      expect(clampFaultParams(FAULT_PARAM_DEFAULTS)).toEqual(
        FAULT_PARAM_DEFAULTS,
      );
    });

    it('holds every probability knob to 0..100', () => {
      // Act
      const high = clampFaultParams({
        clipPct: 150,
        stutterPct: 101,
        dropPct: 1_000,
        silencePct: 100.5,
        corruptPct: 200,
        badHeaderPct: 100.000_1,
      });
      const low = clampFaultParams({
        clipPct: -1,
        stutterPct: -50,
        dropPct: -0.5,
        silencePct: -100,
        corruptPct: -1,
        badHeaderPct: -1,
      });

      // Assert
      for (const value of Object.values(high))
        expect(value).toBeLessThanOrEqual(100);
      expect(high.clipPct).toBe(100);
      expect(high.stutterPct).toBe(100);
      expect(low.clipPct).toBe(0);
      expect(low.corruptPct).toBe(0);
      expect(low.badHeaderPct).toBe(0);
    });

    it('keeps speedup at or above realtime', () => {
      // Arrange — a speedup below 1 would slow the stream down, which is not a
      // fault the transcription service reports; 0 would divide the send
      // interval by nothing at all.

      // Act / Assert
      expect(clampFaultParams({ speedup: 0 }).speedup).toBe(SPEEDUP_MIN);
      expect(clampFaultParams({ speedup: -3 }).speedup).toBe(SPEEDUP_MIN);
      expect(clampFaultParams({ speedup: 99 }).speedup).toBe(SPEEDUP_MAX);
      expect(clampFaultParams({ speedup: Number.NaN }).speedup).toBe(
        SPEEDUP_MIN,
      );
      expect(clampFaultParams({ speedup: 2.5 }).speedup).toBe(2.5);
    });

    it('holds dcOffset to a non-negative fraction of full scale', () => {
      // Act / Assert
      expect(clampFaultParams({ dcOffset: -1 }).dcOffset).toBe(0);
      expect(clampFaultParams({ dcOffset: 5 }).dcOffset).toBe(1);
      expect(clampFaultParams({ dcOffset: 0.25 }).dcOffset).toBe(0.25);
    });

    it('holds clockSkewMs to a range that straddles zero', () => {
      // Arrange — skew is the one knob whose useful values are negative: a
      // `sentAt` in the future produces the negative end-to-end latency the S5
      // clock-skew warning fires on. Clamping it to a floor of 0 would remove
      // the only setting that trips its alert.

      // Act / Assert
      expect(clampFaultParams({ clockSkewMs: -1e9 }).clockSkewMs).toBe(
        CLOCK_SKEW_MS_MIN,
      );
      expect(clampFaultParams({ clockSkewMs: 1e9 }).clockSkewMs).toBe(
        CLOCK_SKEW_MS_MAX,
      );
      expect(clampFaultParams({ clockSkewMs: -3_000 }).clockSkewMs).toBe(
        -3_000,
      );
      expect(clampFaultParams({ clockSkewMs: Number.NaN }).clockSkewMs).toBe(0);
    });

    it('falls back to inert values for every non-finite knob', () => {
      // Arrange — a NaN reaching a probability gate would make `rng() * 100 <
      // NaN` always false, which looks like a knob that is on but never fires.
      const notNumbers = {
        clipPct: Number.NaN,
        stutterPct: Number.POSITIVE_INFINITY,
        dropPct: Number.NEGATIVE_INFINITY,
        speedup: Number.NaN,
        silencePct: Number.NaN,
        dcOffset: Number.NaN,
        corruptPct: Number.NaN,
        badHeaderPct: Number.NaN,
        clockSkewMs: Number.NaN,
      };

      // Act / Assert
      expect(clampFaultParams(notNumbers)).toEqual(FAULT_PARAM_DEFAULTS);
    });
  });
});
