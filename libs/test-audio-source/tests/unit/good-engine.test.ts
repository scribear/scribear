import { describe, expect } from 'vitest';

import { GoodEngine } from '#src/good-engine.js';
import {
  GOOD_PARAM_DEFAULTS,
  type GoodParams,
  NOISE_DB_LEVELS,
} from '#src/params.js';
import { rmsDbfs } from '#src/pcm.js';
import { createSeededRng } from '#src/rng.js';
import { type AudioChunk, decodeWav } from '#src/wav.js';
import {
  CHUNK_MS,
  SAMPLE_RATE,
  chunksOf,
  diffEnergyRatio,
  oneChunk,
  silentPcm,
  sine,
} from '#tests/utils/signals.js';

/** Same tolerance the effects suite holds levels to; see its rationale. */
const LEVEL_TOLERANCE_DB = 0.05;
/** The transcription service calls a window silent under 0.01 linear RMS. */
const INGRESS_SILENCE_FLOOR_DBFS = -40;

function engineWith(params: Partial<GoodParams>, seed = 4_242): GoodEngine {
  return new GoodEngine(
    { ...GOOD_PARAM_DEFAULTS, ...params },
    createSeededRng(seed),
  );
}

function pcmOf(engine: GoodEngine, chunk: AudioChunk): Buffer {
  const plan = engine.plan(chunk);
  const frame = plan.frames[0];
  if (frame === undefined) throw new Error('GoodEngine dropped a frame.');
  return decodeWav(frame.wav).pcm;
}

describe('good-engine', () => {
  describe('plan', (it) => {
    it('hands back the source chunk untouched when every knob is at its default', () => {
      // Arrange — an operator watching captions with the defaults is the common
      // case, and it is worth not decoding and re-encoding a WAV ten times a
      // second to arrive back at the bytes already in hand.
      const chunk = oneChunk(sine(SAMPLE_RATE, 440, 0.5));

      // Act
      const plan = engineWith({}).plan(chunk);

      // Assert
      expect(plan.frames).toHaveLength(1);
      expect(plan.frames[0]?.wav).toBe(chunk.wav);
      expect(plan.frames[0]?.corrupt).toBe(false);
      expect(plan.frames[0]?.reuseChunkId).toBe(false);
      expect(plan.frames[0]?.sentAtSkewMs).toBe(0);
      expect(plan.faulted).toBe(false);
    });

    it('always paces at realtime — this device is the reference', () => {
      // Arrange — nothing the `good` device offers changes the schedule, so a
      // caption delay measured against it is a delay in the pipeline.
      const chunk = oneChunk(sine(SAMPLE_RATE, 440, 0.5));

      // Act / Assert
      for (const params of [
        {},
        { gainDb: -20 },
        { noiseType: 'white' as const },
      ]) {
        expect(engineWith(params).plan(chunk).waitMs).toBeCloseTo(CHUNK_MS, 5);
        expect(engineWith(params).plan(chunk).faulted).toBe(false);
      }
    });

    it('never marks a frame corrupt, and corruptFrame is a pass-through', () => {
      // Arrange — the planner interface is shared with the fault engine, so the
      // method exists; returning the frame untouched is the only defensible
      // answer if a future caller asks anyway.
      const engine = engineWith({});
      const frame = Uint8Array.from([1, 2, 3, 4]);

      // Act / Assert
      expect(engine.corruptFrame(frame)).toEqual(frame);
    });
  });

  describe('gainDb', (it) => {
    it('moves the streamed level by exactly the requested decibels', () => {
      // Arrange — a tone, so the level is analytic and any error belongs to the
      // engine. Both directions, because the range spans too-soft to too-loud
      // on purpose.
      const chunk = oneChunk(sine(SAMPLE_RATE, 440, 0.5));
      const base = rmsDbfs(decodeWav(chunk.wav).pcm);

      // Act / Assert
      for (const gainDb of [-30, -12, -6, 6] as const) {
        const measured = rmsDbfs(pcmOf(engineWith({ gainDb }), chunk));
        expect(Math.abs(measured - (base + gainDb))).toBeLessThan(
          LEVEL_TOLERANCE_DB,
        );
      }
    });

    it('reaches both documented ends of the range', () => {
      // Arrange — -40 dB must put a normal fixture under the ingress meter's
      // silence floor and +20 dB must drive it into clipping. Both ends are
      // meant to be reachable; that is what the parameter is for.
      const chunk = oneChunk(sine(SAMPLE_RATE, 440, 0.5));

      // Act
      const quiet = pcmOf(engineWith({ gainDb: -40 }), chunk);
      const hot = pcmOf(engineWith({ gainDb: 20 }), chunk);

      // Assert
      expect(rmsDbfs(quiet)).toBeLessThan(INGRESS_SILENCE_FLOOR_DBFS);
      // Clipped, so the level lands far short of the +20 dB a linear amplifier
      // would have given — which is the observable, not a defect.
      expect(rmsDbfs(hot)).toBeLessThan(rmsDbfs(decodeWav(chunk.wav).pcm) + 20);
      expect(rmsDbfs(hot)).toBeGreaterThan(-3);
    });

    it('keeps the container intact while rewriting the audio', () => {
      // Arrange — the receiver treats every frame as its own file, so a
      // re-encode that lost the rate or the channel count would break decoding
      // rather than change the level.
      const chunk = oneChunk(sine(SAMPLE_RATE, 440, 0.5));
      const source = decodeWav(chunk.wav);

      // Act
      const plan = engineWith({ gainDb: -6 }).plan(chunk);
      const decoded = decodeWav(plan.frames[0]?.wav ?? Buffer.alloc(0));

      // Assert
      expect(decoded.sampleRate).toBe(source.sampleRate);
      expect(decoded.channels).toBe(source.channels);
      expect(decoded.pcm.length).toBe(source.pcm.length);
    });
  });

  describe('noise floor', (it) => {
    it('lands on each requested level, measured over a whole run', () => {
      // Arrange — mixed into silent chunks so the measured RMS is the floor
      // alone, and concatenated across the run because the level is a property
      // of the stream, not of one 100 ms block.
      const chunks = chunksOf(silentPcm(SAMPLE_RATE));

      // Act / Assert
      for (const noiseType of ['white', 'brown'] as const) {
        for (const noiseDb of NOISE_DB_LEVELS) {
          const engine = engineWith({ noiseType, noiseDb });
          const run = Buffer.concat(
            chunks.map((chunk) => pcmOf(engine, chunk)),
          );
          expect(Math.abs(rmsDbfs(run) - noiseDb)).toBeLessThan(
            LEVEL_TOLERANCE_DB,
          );
        }
      }
    });

    it('keeps the floor absolute when the level trim moves', () => {
      // Arrange — gain first, then the floor. That is what makes -40 dBFS mean
      // -40 dBFS on the meter rather than "-40 dBFS as it would have been
      // before the operator turned the level down". Measured on silent input so
      // the trim cannot contribute anything of its own.
      const chunks = chunksOf(silentPcm(SAMPLE_RATE));
      const NOISE_DB = -30;

      // Act / Assert
      for (const gainDb of [-40, 0, 20] as const) {
        const engine = engineWith({
          gainDb,
          noiseType: 'white',
          noiseDb: NOISE_DB,
        });
        const run = Buffer.concat(chunks.map((chunk) => pcmOf(engine, chunk)));
        expect(Math.abs(rmsDbfs(run) - NOISE_DB)).toBeLessThan(
          LEVEL_TOLERANCE_DB,
        );
      }
    });

    it('stays brown across a whole run, not just within a chunk', () => {
      // Arrange — brown noise is defined by its history. A generator rebuilt
      // per chunk would restart the integrator ten times a second and produce
      // something with a brown spectrum only up to 100 ms. See
      // `diffEnergyRatio` for why this measure separates the two colours.
      const chunks = chunksOf(silentPcm(SAMPLE_RATE * 2));
      const BROWN_CEILING_RATIO = 0.05;
      const WHITE_FLOOR_RATIO = 1.5;

      // Act
      const brownEngine = engineWith({ noiseType: 'brown', noiseDb: -20 });
      const whiteEngine = engineWith({ noiseType: 'white', noiseDb: -20 });
      const brown = Buffer.concat(
        chunks.map((chunk) => pcmOf(brownEngine, chunk)),
      );
      const white = Buffer.concat(
        chunks.map((chunk) => pcmOf(whiteEngine, chunk)),
      );

      // Assert
      expect(diffEnergyRatio(brown)).toBeLessThan(BROWN_CEILING_RATIO);
      expect(diffEnergyRatio(white)).toBeGreaterThan(WHITE_FLOOR_RATIO);
    });

    it('leaves the speech alone at a studio floor', () => {
      // Arrange — -60 dBFS under a -9 dBFS tone is 51 dB down and must be
      // inaudible on the level readout.
      const chunk = oneChunk(sine(SAMPLE_RATE, 440, 0.5));
      const clean = rmsDbfs(decodeWav(chunk.wav).pcm);
      const NEGLIGIBLE_DB = 0.01;

      // Act
      const withFloor = pcmOf(
        engineWith({ noiseType: 'white', noiseDb: -60 }),
        chunk,
      );

      // Assert
      expect(Math.abs(rmsDbfs(withFloor) - clean)).toBeLessThan(NEGLIGIBLE_DB);
    });
  });

  describe('setParams', (it) => {
    it('retunes without restarting the noise generator', () => {
      // Arrange — the generator carries the brown integrator's state, so
      // replacing it on every parameter change would put a seam in the floor
      // each time an operator nudged a slider. The observable of *not*
      // replacing it is that the run stays brown across the change.
      const chunks = chunksOf(silentPcm(SAMPLE_RATE * 2));
      const engine = engineWith({ noiseType: 'brown', noiseDb: -30 });
      const BROWN_CEILING_RATIO = 0.05;

      // Act
      const before = chunks.slice(0, 10).map((chunk) => pcmOf(engine, chunk));
      engine.setParams({
        ...GOOD_PARAM_DEFAULTS,
        noiseType: 'brown',
        noiseDb: -20,
      });
      const after = chunks.slice(10).map((chunk) => pcmOf(engine, chunk));

      // Assert
      expect(engine.params.noiseDb).toBe(-20);
      expect(Math.abs(rmsDbfs(Buffer.concat(before)) - -30)).toBeLessThan(
        LEVEL_TOLERANCE_DB,
      );
      expect(Math.abs(rmsDbfs(Buffer.concat(after)) - -20)).toBeLessThan(
        LEVEL_TOLERANCE_DB,
      );
      expect(diffEnergyRatio(Buffer.concat(after))).toBeLessThan(
        BROWN_CEILING_RATIO,
      );
    });
  });
});
