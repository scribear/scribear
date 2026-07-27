import { describe, expect } from 'vitest';

import {
  AudioFrameError,
  SAFP_MAGIC_0,
  SAFP_MAGIC_1,
  SAFP_VERSION,
  decodeAudioFrame,
  encodeAudioFrame,
} from '@scribear/audio-frame-protocol';

import { applyDcOffset, hardClipToRail } from '#src/effects.js';
import {
  BAD_HEADER_SAMPLE_RATE,
  type ChunkPlan,
  FaultEngine,
  sendIntervalMs,
} from '#src/faults.js';
import { FAULT_PARAM_DEFAULTS, type FaultParams } from '#src/params.js';
import { type Rng, createSeededRng } from '#src/rng.js';
import { type AudioChunk, decodeWav } from '#src/wav.js';
import {
  CHUNK_MS,
  SAMPLE_RATE,
  chunksOf,
  oneChunk,
  sine,
} from '#tests/utils/signals.js';

/** Enough chunks that a knob at 100 has many chances to miss one. */
const CHUNKS = 40;
/** Seed for every engine here; nothing below depends on which one it is. */
const SEED = 20_240_617;

/** The percentage knobs, each of which must be inert at 0 and total at 100. */
const PROBABILITY_KNOBS = [
  'stutterPct',
  'dropPct',
  'silencePct',
  'corruptPct',
  'badHeaderPct',
] as const;

function speech(): AudioChunk[] {
  return chunksOf(sine(SAMPLE_RATE, 440, 0.5));
}

function engineWith(params: Partial<FaultParams>, rng?: Rng): FaultEngine {
  return new FaultEngine(
    { ...FAULT_PARAM_DEFAULTS, ...params },
    rng ?? createSeededRng(SEED),
  );
}

function planAll(engine: FaultEngine, chunks: AudioChunk[]): ChunkPlan[] {
  return chunks.map((chunk) => engine.plan(chunk));
}

describe('faults', () => {
  describe('sendIntervalMs', (it) => {
    it('divides the audio duration by the speed multiple', () => {
      // Arrange — this is the entire implementation of `speedup`, and
      // deliberately the only place it appears.

      // Act / Assert
      expect(sendIntervalMs(100, 1)).toBe(100);
      expect(sendIntervalMs(100, 2)).toBe(50);
      expect(sendIntervalMs(100, 3)).toBeCloseTo(33.333, 3);
    });

    it('refuses to divide by a non-positive multiple', () => {
      // Arrange — a zero would make the interval Infinity and stall the stream
      // rather than speed it up.

      // Act / Assert
      expect(sendIntervalMs(100, 0)).toBe(100);
      expect(sendIntervalMs(100, -2)).toBe(100);
    });
  });

  describe('every knob at zero', (it) => {
    it('puts the source chunk on the wire byte for byte', () => {
      // Arrange — a `fault` device started with no parameters must stream clean
      // audio, so the operator turns on exactly the fault they came to see. The
      // engine re-encodes unconditionally, so "clean" has to mean the bytes are
      // identical, not merely that they decode to the same audio.
      const engine = engineWith({});
      const chunks = speech();

      // Act
      const plans = planAll(engine, chunks);

      // Assert
      for (const [index, plan] of plans.entries()) {
        expect(plan.frames).toHaveLength(1);
        expect(plan.faulted).toBe(false);
        expect(plan.waitMs).toBeCloseTo(CHUNK_MS, 5);
        expect(plan.frames[0]?.corrupt).toBe(false);
        expect(plan.frames[0]?.reuseChunkId).toBe(false);
        expect(plan.frames[0]?.sentAtSkewMs).toBe(0);
        expect(
          plan.frames[0]?.wav.equals(chunks[index]?.wav ?? Buffer.alloc(0)),
        ).toBe(true);
      }
    });

    it('draws nothing from the RNG, so an idle device cannot drift', () => {
      // Arrange — `_draw` short-circuits at 0 rather than comparing against it.
      // That is what lets a seeded run stay reproducible when an operator turns
      // one knob on: the draws that knob makes are the only new ones.
      let draws = 0;
      const counting = () => {
        draws++;
        return 0.5;
      };
      const engine = engineWith({}, counting);

      // Act
      planAll(engine, speech());

      // Assert
      expect(draws).toBe(0);
    });
  });

  describe('every knob at one hundred', (it) => {
    it('marks every chunk faulted', () => {
      // Arrange — the counterpart gate to "0 alters nothing". A knob at 100 is
      // a promise, not a limit: `rng() < 1` is *almost* always true, and almost
      // is not what the top of the range says.

      // Act / Assert
      for (const knob of PROBABILITY_KNOBS) {
        const plans = planAll(engineWith({ [knob]: 100 }), speech());
        expect(plans.every((plan) => plan.faulted)).toBe(true);
      }
    });

    it('replaces every chunk with digital silence at silencePct 100', () => {
      // Act
      const plans = planAll(engineWith({ silencePct: 100 }), speech());

      // Assert
      for (const plan of plans) {
        const decoded = decodeWav(plan.frames[0]?.wav ?? Buffer.alloc(0));
        expect(decoded.pcm.length).toBeGreaterThan(0);
        expect(decoded.pcm.every((byte) => byte === 0)).toBe(true);
      }
    });

    it('repeats every chunk under one id at stutterPct 100', () => {
      // Arrange — the duplicate `chunkId` is the observable the knob is named
      // for, so the second copy has to carry the same audio and ask the
      // streamer to reuse the id rather than mint a fresh one.

      // Act
      const plans = planAll(engineWith({ stutterPct: 100 }), speech());

      // Assert
      for (const plan of plans) {
        expect(plan.frames).toHaveLength(2);
        expect(plan.frames[0]?.reuseChunkId).toBe(false);
        expect(plan.frames[1]?.reuseChunkId).toBe(true);
        expect(
          plan.frames[1]?.wav.equals(plan.frames[0]?.wav ?? Buffer.alloc(0)),
        ).toBe(true);
        // Two chunks of audio must buy two chunks of time, or every stutter
        // would also be a faster-than-realtime burst and `speedup` would stop
        // being the only knob that trips the too-fast path.
        expect(plan.waitMs).toBeCloseTo(CHUNK_MS * 2, 5);
      }
    });

    it('emits nothing at all at dropPct 100, leaving a gap rather than a seam', () => {
      // Arrange — the schedule still has to advance by the chunk's duration, so
      // the next chunk goes out when it would have and the hole is real.

      // Act
      const plans = planAll(engineWith({ dropPct: 100 }), speech());

      // Assert
      for (const plan of plans) {
        expect(plan.frames).toHaveLength(0);
        expect(plan.waitMs).toBeCloseTo(CHUNK_MS, 5);
      }
    });

    it('marks every frame corrupt at corruptPct 100, including a stuttered copy', () => {
      // Arrange — the two frames of a stutter draw independently, so stacking a
      // stutter and a corruption must not be more or less likely than either
      // alone. At 100 both are certain, which is what makes that assertable.

      // Act
      const plans = planAll(
        engineWith({ corruptPct: 100, stutterPct: 100 }),
        speech(),
      );

      // Assert
      for (const plan of plans) {
        expect(plan.frames).toHaveLength(2);
        expect(plan.frames.every((frame) => frame.corrupt)).toBe(true);
      }
    });

    it('leaves nothing corrupt at corruptPct 0', () => {
      // Act
      const plans = planAll(
        engineWith({ corruptPct: 0, stutterPct: 100 }),
        speech(),
      );

      // Assert
      expect(
        plans.flatMap((plan) => plan.frames).some((frame) => frame.corrupt),
      ).toBe(false);
    });
  });

  describe('badHeaderPct', (it) => {
    it('still parses as a WAV but declares the wrong sample rate', () => {
      // Arrange — the fault being reproduced is a *plausible*
      // misconfiguration, a source left at telephone rate, and it has to be a
      // header the transcription service's decoder will open far enough to
      // notice the mismatch. A header that failed to parse would be a different
      // fault with a different signature.
      const chunk = oneChunk(sine(SAMPLE_RATE, 440, 0.5));
      const source = decodeWav(chunk.wav);

      // Act
      const plan = engineWith({ badHeaderPct: 100 }).plan(chunk);
      const decoded = decodeWav(plan.frames[0]?.wav ?? Buffer.alloc(0));

      // Assert
      expect(decoded.sampleRate).toBe(BAD_HEADER_SAMPLE_RATE);
      expect(decoded.sampleRate).not.toBe(source.sampleRate);
      expect(decoded.channels).toBe(source.channels);
      // The audio itself is untouched: only the container lies.
      expect(decoded.pcm.equals(source.pcm)).toBe(true);
    });

    it('preserves the true rate at 0', () => {
      // Act
      const chunk = oneChunk(sine(SAMPLE_RATE, 440, 0.5));
      const plan = engineWith({ badHeaderPct: 0 }).plan(chunk);

      // Assert
      expect(decodeWav(plan.frames[0]?.wav ?? Buffer.alloc(0)).sampleRate).toBe(
        SAMPLE_RATE,
      );
    });
  });

  describe('corruptFrame', (it) => {
    it('makes the real decoder reject the frame, every time', () => {
      // Arrange — asserted against `decodeAudioFrame` itself rather than
      // against an idea of what a corrupt frame looks like. A single flipped
      // bit is used precisely because CRC-32 detects every single-bit error, so
      // this fails deterministically where a truncation would not.
      const engine = engineWith({});
      const frame = encodeAudioFrame(
        { chunkId: 'chunk-under-test', sentAt: 1_700_000_000_000 },
        new Uint8Array(oneChunk(sine(SAMPLE_RATE, 440, 0.5)).wav),
      );
      const ATTEMPTS = 200;

      // Act / Assert
      expect(() => decodeAudioFrame(frame)).not.toThrow();
      for (let i = 0; i < ATTEMPTS; i++) {
        expect(() => decodeAudioFrame(engine.corruptFrame(frame))).toThrow(
          AudioFrameError,
        );
      }
    });

    it('fails on the CRC rather than on the magic, so it feeds the decode-drop counter', () => {
      // Arrange — damage inside the first four bytes would produce "not a SAFP
      // frame" instead, which is a different failure with a different meaning
      // downstream. The corrupter confines itself to the body for that reason.
      const engine = engineWith({});
      const frame = encodeAudioFrame({ chunkId: 'c' }, new Uint8Array(512));
      const ATTEMPTS = 200;

      // Act / Assert
      for (let i = 0; i < ATTEMPTS; i++) {
        const damaged = engine.corruptFrame(frame);
        expect(damaged).toHaveLength(frame.length);
        expect(damaged[0]).toBe(SAFP_MAGIC_0);
        expect(damaged[1]).toBe(SAFP_MAGIC_1);
        expect(damaged[2]).toBe(SAFP_VERSION);
        expect(() => decodeAudioFrame(damaged)).toThrow(/CRC/);
      }
    });

    it('leaves the caller-owned frame untouched', () => {
      // Arrange — the streamer keeps the encoded frame it handed in; corrupting
      // in place would damage the copy a retry or a log would use.
      const engine = engineWith({});
      const frame = encodeAudioFrame({ chunkId: 'c' }, new Uint8Array(64));
      const before = Uint8Array.from(frame);

      // Act
      engine.corruptFrame(frame);

      // Assert
      expect(frame).toEqual(before);
    });
  });

  describe('waveform knobs', (it) => {
    it('composes clipping and DC bias in the order the effects define', () => {
      // Arrange — the engine must not have its own copy of the ordering. This
      // pins it against the two public primitives applied by hand, so the day
      // the order changes both this and the effects suite say so.
      const chunk = oneChunk(sine(SAMPLE_RATE, 440, 0.5));
      const source = decodeWav(chunk.wav);
      const CLIP_PCT = 40;
      const DC = 0.2;

      // Act
      const plan = engineWith({ clipPct: CLIP_PCT, dcOffset: DC }).plan(chunk);
      const expected = applyDcOffset(hardClipToRail(source.pcm, CLIP_PCT), DC);

      // Assert
      expect(
        decodeWav(plan.frames[0]?.wav ?? Buffer.alloc(0)).pcm.equals(expected),
      ).toBe(true);
      expect(plan.faulted).toBe(true);
    });

    it('lets silence win over clipping, because there is nothing left to clip', () => {
      // Act
      const chunk = oneChunk(sine(SAMPLE_RATE, 440, 0.5));
      const plan = engineWith({
        silencePct: 100,
        clipPct: 100,
        dcOffset: 0.5,
      }).plan(chunk);

      // Assert
      const decoded = decodeWav(plan.frames[0]?.wav ?? Buffer.alloc(0));
      expect(decoded.pcm.every((byte) => byte === 0)).toBe(true);
    });

    it('counts a waveform knob as a fault on every chunk, not probabilistically', () => {
      // Arrange — `clipPct` and `dcOffset` are levels rather than
      // probabilities, so every chunk they are on for is altered.

      // Act / Assert
      expect(
        planAll(engineWith({ clipPct: 1 }), speech()).every((p) => p.faulted),
      ).toBe(true);
      expect(
        planAll(engineWith({ dcOffset: 0.01 }), speech()).every(
          (p) => p.faulted,
        ),
      ).toBe(true);
    });
  });

  describe('speedup', (it) => {
    it('changes the send schedule and nothing else', () => {
      // Arrange — the knob exists to trip the transcription service's
      // faster-than-realtime rejection. If it also changed the audio, an
      // operator could not tell which of two faults they were looking at, so
      // the frames must be byte-identical to what speedup 1 would have sent.
      const chunks = speech();
      const SPEEDUP = 2.5;

      // Act
      const realtime = planAll(engineWith({ speedup: 1 }), chunks);
      const fast = planAll(engineWith({ speedup: SPEEDUP }), chunks);

      // Assert
      for (const [index, plan] of fast.entries()) {
        const reference = realtime[index];
        expect(plan.waitMs).toBeCloseTo((reference?.waitMs ?? 0) / SPEEDUP, 6);
        expect(plan.frames).toHaveLength(reference?.frames.length ?? -1);
        expect(
          plan.frames[0]?.wav.equals(
            reference?.frames[0]?.wav ?? Buffer.alloc(0),
          ),
        ).toBe(true);
      }
    });

    it('does not count as a fault on any frame', () => {
      // Arrange — it changes when frames are sent and nothing about the frames
      // themselves. Counting its runs as faulted frames would make the counter
      // agree with neither its name nor what is on the wire.

      // Act
      const plans = planAll(engineWith({ speedup: 3 }), speech());

      // Assert
      expect(plans.some((plan) => plan.faulted)).toBe(false);
    });
  });

  describe('clockSkewMs', (it) => {
    it('is carried on every planned frame, including a stuttered copy', () => {
      // Arrange — the skew is metadata rather than audio, so it rides on the
      // plan for the streamer to add to the timestamp it computes.
      const SKEW = -3_000;

      // Act
      const plans = planAll(
        engineWith({ clockSkewMs: SKEW, stutterPct: 100 }),
        speech(),
      );

      // Assert
      for (const plan of plans) {
        expect(plan.frames.map((frame) => frame.sentAtSkewMs)).toEqual([
          SKEW,
          SKEW,
        ]);
        expect(plan.faulted).toBe(true);
      }
    });
  });

  describe('setParams', (it) => {
    it('retunes a running engine from the next chunk on', () => {
      // Arrange — an operator moving a slider on a live device must not have to
      // restart it, and the change must not apply retroactively to a chunk
      // already planned.
      const chunks = speech();
      const engine = engineWith({});
      const first = chunks[0];
      const second = chunks[1];
      if (first === undefined || second === undefined)
        throw new Error('need 2 chunks');

      // Act
      const before = engine.plan(first);
      engine.setParams({ ...FAULT_PARAM_DEFAULTS, silencePct: 100 });
      const after = engine.plan(second);

      // Assert
      expect(before.faulted).toBe(false);
      expect(engine.params.silencePct).toBe(100);
      expect(
        decodeWav(after.frames[0]?.wav ?? Buffer.alloc(0)).pcm.every(
          (byte) => byte === 0,
        ),
      ).toBe(true);
    });
  });

  describe('determinism', (it) => {
    it('replays the same damage for the same seed', () => {
      // Arrange — every interesting assertion about a fault engine is about the
      // exact sequence of decisions a seed produces, not about an aggregate
      // rate. Two engines on the same seed must agree frame for frame.
      const chunks = chunksOf(sine(SAMPLE_RATE * (CHUNKS / 10), 440, 0.5));
      const mixed: Partial<FaultParams> = {
        dropPct: 30,
        stutterPct: 25,
        corruptPct: 40,
        silencePct: 20,
        badHeaderPct: 35,
      };

      // Act
      const shapeOf = (engine: FaultEngine) =>
        planAll(engine, chunks).map((plan) => ({
          frameCount: plan.frames.length,
          corrupt: plan.frames.map((frame) => frame.corrupt),
          faulted: plan.faulted,
        }));
      const first = shapeOf(engineWith(mixed, createSeededRng(SEED)));
      const second = shapeOf(engineWith(mixed, createSeededRng(SEED)));
      const other = shapeOf(engineWith(mixed, createSeededRng(SEED + 1)));

      // Assert
      expect(second).toEqual(first);
      expect(other).not.toEqual(first);
      // Sanity: the seed actually exercised the knobs rather than missing them.
      expect(first.some((plan) => plan.frameCount === 0)).toBe(true);
      expect(first.some((plan) => plan.frameCount === 2)).toBe(true);
    });
  });
});
