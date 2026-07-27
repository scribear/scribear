import { describe, expect } from 'vitest';

import {
  FULL_SCALE,
  INT16_MAX,
  INT16_MIN,
  dbToLinear,
  dcOffsetOf,
  fromFloat,
  peakOf,
  rmsDbfs,
  sampleCount,
  saturate,
  toFloat,
} from '#src/pcm.js';
import {
  SAMPLE_RATE,
  samplesOf,
  silentPcm,
  sine,
} from '#tests/utils/signals.js';

/** RMS of a sine is `amplitude / sqrt(2)`, i.e. 3.01 dB under its peak. */
const SINE_RMS_UNDER_PEAK_DB = 3.0103;
/** dBFS of a half-scale sine: 20*log10(0.5/sqrt(2)). */
const HALF_SCALE_SINE_DBFS = -9.0309;

describe('pcm', () => {
  describe('saturate', (it) => {
    it('clamps at both rails instead of wrapping', () => {
      // Arrange — these are the values +20 dB of gain on a loud fixture
      // actually produces. Wrapping them would put a full-scale sample of the
      // opposite sign on the wire, which sounds like a broken decoder.
      const wellPastPositiveRail = 294_912; // 0.9 full scale * 10
      const wellPastNegativeRail = -294_912;

      // Act / Assert
      expect(saturate(wellPastPositiveRail)).toBe(INT16_MAX);
      expect(saturate(wellPastNegativeRail)).toBe(INT16_MIN);
      expect(saturate(INT16_MAX + 1)).toBe(INT16_MAX);
      expect(saturate(INT16_MIN - 1)).toBe(INT16_MIN);
    });

    it('rounds to the nearest sample rather than truncating', () => {
      // Act / Assert — truncation would bias every effect toward zero, which
      // shows up as a fraction of a dB of level error on a long fixture.
      expect(saturate(100.4)).toBe(100);
      expect(saturate(100.6)).toBe(101);
      expect(saturate(-100.6)).toBe(-101);
      expect(saturate(0)).toBe(0);
    });
  });

  describe('sampleCount', (it) => {
    it('ignores a trailing odd byte rather than reading past it', () => {
      // Arrange — a 5-byte buffer holds two whole samples and one stray byte.
      const ragged = Buffer.alloc(5);

      // Act / Assert
      expect(sampleCount(ragged)).toBe(2);
      expect(sampleCount(Buffer.alloc(0))).toBe(0);
    });
  });

  describe('toFloat / fromFloat', (it) => {
    it('round-trips every sample exactly, including both rails', () => {
      // Arrange — FULL_SCALE is 32768 so INT16_MIN is exactly -1.0; if the
      // convention were 32767 the round trip would drift by an LSB at the rail.
      const pcm = Buffer.alloc(8);
      pcm.writeInt16LE(INT16_MIN, 0);
      pcm.writeInt16LE(-1, 2);
      pcm.writeInt16LE(0, 4);
      pcm.writeInt16LE(INT16_MAX, 6);

      // Act
      const floats = toFloat(pcm);
      const back = fromFloat(floats);

      // Assert
      expect(floats[0]).toBe(-1);
      expect(floats[3]).toBeCloseTo(INT16_MAX / FULL_SCALE, 10);
      expect(back.equals(pcm)).toBe(true);
    });

    it('saturates a float above full scale instead of wrapping it', () => {
      // Arrange — anything that sums signals (the noise mixer) can overshoot
      // 1.0, and a wrap there would be an audible full-scale sign inversion.
      const overdriven = Float64Array.from([1.5, -1.5, 1, -1]);

      // Act
      const pcm = fromFloat(overdriven);

      // Assert
      expect(samplesOf(pcm)).toEqual([
        INT16_MAX,
        INT16_MIN,
        INT16_MAX,
        INT16_MIN,
      ]);
    });
  });

  describe('rmsDbfs', (it) => {
    it('measures a half-scale sine at its analytic level', () => {
      // Arrange — 0.5 of full scale peak, so RMS is 0.5/sqrt(2) = -9.03 dBFS.
      const pcm = sine(SAMPLE_RATE, 440, 0.5);

      // Act / Assert
      expect(rmsDbfs(pcm)).toBeCloseTo(HALF_SCALE_SINE_DBFS, 2);
      expect(rmsDbfs(sine(SAMPLE_RATE, 440, 1))).toBeCloseTo(
        -SINE_RMS_UNDER_PEAK_DB,
        2,
      );
    });

    it('reports digital silence as -Infinity, not a floor value', () => {
      // Arrange — a caller comparing against a silence threshold gets the right
      // answer from -Infinity with no special case; NaN or -120 would not.

      // Act / Assert
      expect(rmsDbfs(silentPcm(1_000))).toBe(Number.NEGATIVE_INFINITY);
      expect(rmsDbfs(Buffer.alloc(0))).toBe(Number.NEGATIVE_INFINITY);
    });
  });

  describe('dcOffsetOf', (it) => {
    it('reads zero for a full-cycle tone and the bias for a shifted one', () => {
      // Arrange — a whole number of cycles has no DC by construction, so any
      // reading above the rounding floor would be the measurement's own error.
      const cycles = sine(SAMPLE_RATE, 100, 0.5);
      const biased = Buffer.alloc(cycles.length);
      for (let i = 0; i < cycles.length; i += 2) {
        biased.writeInt16LE(
          saturate(cycles.readInt16LE(i) + 0.25 * FULL_SCALE),
          i,
        );
      }

      // Act / Assert
      expect(dcOffsetOf(cycles)).toBeCloseTo(0, 4);
      expect(dcOffsetOf(biased)).toBeCloseTo(0.25, 4);
      expect(dcOffsetOf(Buffer.alloc(0))).toBe(0);
    });
  });

  describe('peakOf', (it) => {
    it('normalises the largest magnitude against full scale', () => {
      // Arrange — INT16_MIN is the largest magnitude an int16 can hold, and it
      // must read as exactly 1.0 for "peaked at the rail" to be assertable.
      const railed = Buffer.alloc(4);
      railed.writeInt16LE(INT16_MIN, 0);
      railed.writeInt16LE(1_000, 2);

      // Act / Assert
      expect(peakOf(railed)).toBe(1);
      expect(peakOf(sine(1_000, 440, 0.5))).toBeCloseTo(0.5, 2);
      expect(peakOf(silentPcm(100))).toBe(0);
    });
  });

  describe('dbToLinear', (it) => {
    it('converts the decibel figures the knobs are calibrated in', () => {
      // Act / Assert — -6 dB is half amplitude, +20 dB is ten times, and 0 dB
      // must be exactly 1 so an untouched chunk stays byte-identical.
      expect(dbToLinear(0)).toBe(1);
      expect(dbToLinear(-6)).toBeCloseTo(0.501_187, 5);
      expect(dbToLinear(20)).toBeCloseTo(10, 10);
      expect(dbToLinear(-40)).toBeCloseTo(0.01, 10);
    });
  });
});
