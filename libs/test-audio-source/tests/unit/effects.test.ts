import { describe, expect } from 'vitest';

import {
  NoiseGenerator,
  applyDcOffset,
  applyGainDb,
  clippedFraction,
  digitalSilence,
  hardClipToRail,
} from '#src/effects.js';
import { NOISE_DB_LEVELS } from '#src/params.js';
import { INT16_MAX, INT16_MIN, dcOffsetOf, peakOf, rmsDbfs } from '#src/pcm.js';
import { createSeededRng } from '#src/rng.js';
import {
  SAMPLE_RATE,
  diffEnergyRatio,
  sampleRange,
  samplesOf,
  signFlips,
  silentPcm,
  sine,
} from '#tests/utils/signals.js';

/**
 * How close a measured level has to be to the requested one.
 *
 * 0.05 dB is far tighter than anything an operator could read off a meter, and
 * far looser than int16 rounding on a healthy signal: the measured errors are
 * around 0.001 dB. A failure at this tolerance is a real defect, not noise.
 */
const LEVEL_TOLERANCE_DB = 0.05;

/** Level of a half-scale sine: 20*log10(0.5/sqrt(2)). */
const HALF_SCALE_SINE_DBFS = -9.0309;

/**
 * The transcription service's ingress meter calls a window silent below a
 * linear RMS of 0.01, i.e. -40 dBFS (`audio_meter.py`, `silence_threshold`).
 */
const INGRESS_SILENCE_FLOOR_DBFS = -40;

/** One second of speech-level tone: enough samples for a stable RMS. */
function fixture(amplitude = 0.5): Buffer {
  return sine(SAMPLE_RATE, 440, amplitude);
}

describe('effects', () => {
  describe('applyGainDb', (it) => {
    it('moves the measured RMS by exactly the requested decibels', () => {
      // Arrange — the gate for this module is "20 dB of gain raises the
      // measured RMS by 20 dB". A tone is used because its level is analytic,
      // so any error the test sees belongs to the effect.
      const pcm = fixture();
      const base = rmsDbfs(pcm);
      const REQUESTED = [-20, -12, -6, -3, 3, 6] as const;

      // Act / Assert
      for (const gainDb of REQUESTED) {
        const measured = rmsDbfs(applyGainDb(pcm, gainDb));
        expect(Math.abs(measured - (base + gainDb))).toBeLessThan(
          LEVEL_TOLERANCE_DB,
        );
      }
      expect(base).toBeCloseTo(HALF_SCALE_SINE_DBFS, 2);
    });

    it('saturates at the rail on +20 dB rather than wrapping', () => {
      // Arrange — +20 dB on a fixture that already peaks near full scale is a
      // *supported* setting whose intended observable is clipping. An int16
      // wrap would instead put full-scale samples of the opposite sign on the
      // wire: catastrophic, audible, and the obvious implementation mistake.
      const loud = fixture(0.9);

      // Act
      const hot = applyGainDb(loud, 20);

      // Assert — no sample changed sign, which is the wrap signature, and both
      // rails are reached rather than exceeded.
      expect(signFlips(loud, hot)).toBe(0);
      expect(peakOf(hot)).toBe(1);
      const range = sampleRange(hot);
      expect(range.min).toBe(INT16_MIN);
      expect(range.max).toBe(INT16_MAX);
      for (const sample of samplesOf(hot)) {
        expect(sample).toBeGreaterThanOrEqual(INT16_MIN);
        expect(sample).toBeLessThanOrEqual(INT16_MAX);
      }
    });

    it('drives a normal fixture under the ingress meter silence floor at -40 dB', () => {
      // Arrange — the bottom of the range exists so an operator can make the
      // silence telemetry move. If the clamp or the conversion were wrong this
      // end of the knob would do nothing observable.
      const pcm = fixture();

      // Act
      const quiet = applyGainDb(pcm, -40);

      // Assert
      expect(rmsDbfs(quiet)).toBeLessThan(INGRESS_SILENCE_FLOOR_DBFS);
    });

    it('is a byte-for-byte no-op at 0 dB', () => {
      // Arrange — an operator watching captions with every knob at its default
      // is the common case, and it must not be re-quantised ten times a second.
      const pcm = fixture();

      // Act / Assert
      expect(applyGainDb(pcm, 0).equals(pcm)).toBe(true);
    });
  });

  describe('NoiseGenerator', (it) => {
    it('lands within tolerance of every one of the five offered floors', () => {
      // Arrange — mixed into digital silence so the measured RMS is the noise
      // floor alone. The level is absolute, not relative to the signal: an
      // operator who asks for -40 dBFS wants the meter to read -40 dBFS.
      const generator = new NoiseGenerator(createSeededRng(20_240_617));

      // Act / Assert
      for (const type of ['white', 'brown'] as const) {
        for (const dbfs of NOISE_DB_LEVELS) {
          const noise = generator.mixInto(silentPcm(SAMPLE_RATE), type, dbfs);
          expect(Math.abs(rmsDbfs(noise) - dbfs)).toBeLessThan(
            LEVEL_TOLERANCE_DB,
          );
        }
      }
    });

    it('makes brown noise measurably lower-frequency than white', () => {
      // Arrange — see `diffEnergyRatio`: differencing is a first-order
      // high-pass, so the ratio is 2*(1 - r) for lag-1 autocorrelation r. White
      // noise is uncorrelated and sits at 2.0; the brown generator's leaky
      // integrator (leak 0.995, a one-pole at ~12.7 Hz) sits near 0.01. Two
      // orders of magnitude apart, so the ordering is not a close call.
      const generator = new NoiseGenerator(createSeededRng(1_234));
      const WHITE_EXPECTED_RATIO = 2;
      const WHITE_RATIO_TOLERANCE = 0.1;
      const BROWN_CEILING_RATIO = 0.05;

      // Act
      const white = generator.mixInto(silentPcm(SAMPLE_RATE * 2), 'white', -20);
      const brown = generator.mixInto(silentPcm(SAMPLE_RATE * 2), 'brown', -20);

      // Assert
      expect(diffEnergyRatio(brown)).toBeLessThan(diffEnergyRatio(white));
      expect(
        Math.abs(diffEnergyRatio(white) - WHITE_EXPECTED_RATIO),
      ).toBeLessThan(WHITE_RATIO_TOLERANCE);
      expect(diffEnergyRatio(brown)).toBeLessThan(BROWN_CEILING_RATIO);
    });

    it('keeps brown noise brown across chunk boundaries', () => {
      // Arrange — brown noise is defined by its history, so a generator rebuilt
      // per 100 ms chunk would restart the integrator ten times a second and
      // produce something measurably closer to white. One shared RNG feeds both
      // arms so the only difference between them is the integrator state.
      const shared = createSeededRng(77);
      const persistent = new NoiseGenerator(shared);
      const BLOCKS = 20;
      const BLOCK_FRAMES = (SAMPLE_RATE * 100) / 1000;

      // Act
      const kept = Buffer.concat(
        Array.from({ length: BLOCKS }, () =>
          persistent.mixInto(silentPcm(BLOCK_FRAMES), 'brown', -20),
        ),
      );
      const restarted = Buffer.concat(
        Array.from({ length: BLOCKS }, () =>
          new NoiseGenerator(shared).mixInto(
            silentPcm(BLOCK_FRAMES),
            'brown',
            -20,
          ),
        ),
      );

      // Assert
      expect(diffEnergyRatio(kept)).toBeLessThan(diffEnergyRatio(restarted));
    });

    it('adds a floor without disturbing the speech it is mixed into', () => {
      // Arrange — a -40 dBFS floor under a -9 dBFS tone is 31 dB down, so it
      // must move the total level by well under a tenth of a dB. A generator
      // that scaled relative to the signal, or that replaced rather than
      // summed, would fail this by a wide margin.
      const generator = new NoiseGenerator(createSeededRng(5));
      const speech = fixture();
      const NEGLIGIBLE_DB = 0.01;

      // Act
      const mixed = generator.mixInto(speech, 'white', -40);

      // Assert
      expect(Math.abs(rmsDbfs(mixed) - rmsDbfs(speech))).toBeLessThan(
        NEGLIGIBLE_DB,
      );
    });

    it('does not smuggle a DC offset in with the brown floor', () => {
      // Arrange — a *pure* integrator is a random walk whose block mean is the
      // same order as its RMS, which would make the noise type quietly supply
      // the bias the `dcOffset` knob is supposed to own. Leaking bounds it: at
      // -20 dBFS the floor's own RMS is 0.1, and its mean must stay a fraction
      // of that.
      const generator = new NoiseGenerator(createSeededRng(31));
      const NOISE_DBFS = -20;
      const NOISE_RMS = 0.1;
      const MAX_DC_AS_FRACTION_OF_RMS = 0.5;

      // Act
      const brown = generator.mixInto(
        silentPcm(SAMPLE_RATE),
        'brown',
        NOISE_DBFS,
      );

      // Assert
      expect(Math.abs(dcOffsetOf(brown))).toBeLessThan(
        NOISE_RMS * MAX_DC_AS_FRACTION_OF_RMS,
      );
    });

    it('leaves an empty chunk alone', () => {
      // Arrange — a zero-length chunk has no RMS to normalise against.
      const generator = new NoiseGenerator(createSeededRng(1));

      // Act / Assert
      expect(generator.mixInto(Buffer.alloc(0), 'white', -40).length).toBe(0);
    });
  });

  describe('hardClipToRail', (it) => {
    it('raises the share of samples at the rail monotonically with the knob', () => {
      // Arrange — the knob is a *target share of clipped samples*, not a
      // ceiling, because the ingress meter counts samples at the rail: a
      // waveform clamped at half scale is not clipped as far as any telemetry
      // in the stack is concerned. A tone gives a continuous amplitude
      // distribution, so each requested percentile is distinct.
      const pcm = fixture();
      const REQUESTED_PCT = [1, 5, 10, 25, 50, 90] as const;
      const SHARE_TOLERANCE = 0.02;

      // Act
      const measured = REQUESTED_PCT.map((pct) =>
        clippedFraction(hardClipToRail(pcm, pct)),
      );

      // Assert
      expect(clippedFraction(pcm)).toBe(0);
      for (let i = 0; i < measured.length; i++) {
        const share = measured[i] ?? 0;
        expect(share).toBeGreaterThan(measured[i - 1] ?? 0);
        expect(Math.abs(share - (REQUESTED_PCT[i] ?? 0) / 100)).toBeLessThan(
          SHARE_TOLERANCE,
        );
      }
    });

    it('counts the negative rail as clipped, not just the positive one', () => {
      // Arrange — a square wave saturates every sample, so the clipped share
      // must be 1.0. It is the regression test for a detector that only
      // recognised INT16_MIN: the gain applied here lands negative peaks on
      // -32767, and the meter this mirrors counts anything with |x| >= 0.99.
      const FRAMES = 4_000;
      const square = Buffer.alloc(FRAMES * 2);
      for (let i = 0; i < FRAMES; i++) {
        square.writeInt16LE(
          Math.floor(i / 40) % 2 === 0 ? 8_000 : -8_000,
          i * 2,
        );
      }

      // Act
      const clipped = hardClipToRail(square, 100);

      // Assert
      expect(clippedFraction(clipped)).toBe(1);
      for (const sample of samplesOf(clipped)) {
        expect(Math.abs(sample)).toBeGreaterThanOrEqual(INT16_MAX);
      }
    });

    it('bounds the sample range and never inverts a sample', () => {
      // Arrange — clipping may only push a sample toward a rail of its own
      // sign. An inverted peak would be a wrap, not a clip.
      const pcm = fixture();

      // Act
      const clipped = hardClipToRail(pcm, 50);

      // Assert
      const range = sampleRange(clipped);
      expect(range.min).toBeGreaterThanOrEqual(INT16_MIN);
      expect(range.max).toBeLessThanOrEqual(INT16_MAX);
      expect(signFlips(pcm, clipped)).toBe(0);
    });

    it('is a hard no-op at 0 rather than a limiting case', () => {
      // Arrange — at clipPct = 0 the percentile is the chunk's own peak, so a
      // "limiting case" implementation would normalise a quiet fixture up to
      // full scale: a large audible change made by a knob set to off.
      const quiet = fixture(0.05);

      // Act / Assert
      expect(hardClipToRail(quiet, 0).equals(quiet)).toBe(true);
      expect(hardClipToRail(quiet, -5).equals(quiet)).toBe(true);
      expect(rmsDbfs(hardClipToRail(quiet, 0))).toBe(rmsDbfs(quiet));
    });

    it('leaves digital silence silent instead of asking for infinite gain', () => {
      // Arrange — the pivot is floored at one LSB so a silent chunk cannot
      // divide by zero. There is no waveform there to clip.
      const silence = silentPcm(1_600);

      // Act / Assert
      expect(hardClipToRail(silence, 100).equals(silence)).toBe(true);
      expect(hardClipToRail(Buffer.alloc(0), 50).length).toBe(0);
    });
  });

  describe('applyDcOffset', (it) => {
    it('shifts the mean by the requested fraction of full scale', () => {
      // Arrange — a whole number of cycles has no DC of its own, so the entire
      // measured mean is the bias. The amplitude leaves headroom for the shift
      // so nothing clips and the knob can be checked exactly.
      const pcm = sine(SAMPLE_RATE, 100, 0.5);
      const REQUESTED = 0.25;

      // Act
      const biased = applyDcOffset(pcm, REQUESTED);

      // Assert
      expect(dcOffsetOf(biased)).toBeCloseTo(REQUESTED, 3);
      expect(dcOffsetOf(pcm)).toBeCloseTo(0, 4);
    });

    it('saturates at the rail when the bias pushes past it', () => {
      // Arrange — 0.9 peak plus 0.5 of bias overshoots full scale by 0.4, so
      // the positive half must land on the rail. Wrapping would drop those
      // peaks to the *negative* rail, and the measured mean would fall instead
      // of rising.
      const loud = sine(SAMPLE_RATE, 100, 0.9);
      const REQUESTED = 0.5;

      // Act
      const biased = applyDcOffset(loud, REQUESTED);

      // Assert
      const range = sampleRange(biased);
      expect(range.max).toBe(INT16_MAX);
      expect(range.min).toBeGreaterThan(INT16_MIN);
      // Clipping the positive half necessarily costs some of the bias; what
      // must not happen is the mean going backwards.
      expect(dcOffsetOf(biased)).toBeGreaterThan(0);
      expect(dcOffsetOf(biased)).toBeLessThan(REQUESTED);
    });

    it('is a byte-for-byte no-op at 0', () => {
      // Act / Assert
      const pcm = fixture();
      expect(applyDcOffset(pcm, 0).equals(pcm)).toBe(true);
    });
  });

  describe('digitalSilence', (it) => {
    it('is all zeros, byte-for-byte the length of the chunk it replaces', () => {
      // Arrange — the replacement has to keep the frame's byte length so the
      // chunk still accounts for the same span of audio.
      const original = fixture();

      // Act
      const silence = digitalSilence(original.length);

      // Assert
      expect(silence.length).toBe(original.length);
      expect(silence.every((byte) => byte === 0)).toBe(true);
      expect(rmsDbfs(silence)).toBe(Number.NEGATIVE_INFINITY);
    });
  });

  describe('composition', (it) => {
    it('undershoots the bias when clipping runs first and overshoots when it runs last', () => {
      // Arrange — this is why the order in `FaultEngine._buildWav` is fixed,
      // and it is not the order a reader would guess. `hardClipToRail` is a
      // *gain*, not a ceiling, so a bias applied before it is amplified along
      // with the signal and lands well past what was asked for; applied after
      // it, the already-saturated positive half eats part of the shift and the
      // result lands short. Neither is exact, and the chosen order is the one
      // that errs downward.
      const pcm = fixture();
      const CLIP_PCT = 50;
      const REQUESTED_DC = 0.25;

      // Act
      const clipThenBias = applyDcOffset(
        hardClipToRail(pcm, CLIP_PCT),
        REQUESTED_DC,
      );
      const biasThenClip = hardClipToRail(
        applyDcOffset(pcm, REQUESTED_DC),
        CLIP_PCT,
      );

      // Assert
      expect(dcOffsetOf(clipThenBias)).toBeLessThan(REQUESTED_DC);
      expect(dcOffsetOf(biasThenClip)).toBeGreaterThan(REQUESTED_DC);
      expect(dcOffsetOf(clipThenBias)).toBeGreaterThan(0);
    });

    it('lifts samples off the negative rail when a bias is stacked on clipping', () => {
      // Arrange — the honest consequence of the chosen order, pinned here so a
      // future change to it is visible rather than silent: adding a positive
      // bias moves every negative-rail sample inward by that much, so the
      // clipped share an operator sees on the ingress meter reads *below* the
      // `clipPct` they set whenever `dcOffset` is also on.
      const pcm = fixture();
      const CLIP_PCT = 90;

      // Act
      const clippedOnly = hardClipToRail(pcm, CLIP_PCT);
      const clippedAndBiased = applyDcOffset(clippedOnly, 0.25);

      // Assert
      expect(clippedFraction(clippedOnly)).toBeGreaterThan(
        clippedFraction(clippedAndBiased),
      );
      expect(clippedFraction(clippedAndBiased)).toBeGreaterThan(0);
    });

    it('leaves a valid int16 buffer after every effect is stacked', () => {
      // Arrange — four transforms over one chunk, each of which can saturate.
      const generator = new NoiseGenerator(createSeededRng(8));
      const pcm = fixture(0.8);

      // Act
      let out = applyGainDb(pcm, 12);
      out = hardClipToRail(out, 30);
      out = applyDcOffset(out, 0.2);
      out = generator.mixInto(out, 'brown', -30);

      // Assert
      expect(out.length).toBe(pcm.length);
      expect(out.length % 2).toBe(0);
      for (const sample of samplesOf(out)) {
        expect(Number.isInteger(sample)).toBe(true);
        expect(sample).toBeGreaterThanOrEqual(INT16_MIN);
        expect(sample).toBeLessThanOrEqual(INT16_MAX);
      }
    });
  });
});
