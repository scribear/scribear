import { applyGainDb, NoiseGenerator } from './effects.js';
import type { ChunkPlanner, ChunkPlan } from './faults.js';
import type { GoodParams } from './params.js';
import type { Rng } from './rng.js';
import { type AudioChunk, decodeWav, encodeWav } from './wav.js';

/**
 * The `good` device's planner: level trim and a noise floor, nothing else.
 *
 * Implements the same {@link ChunkPlanner} interface the fault engine does, so
 * one streamer drives both devices and there is exactly one implementation of
 * pacing, framing and reconnection to get right. This one simply never drops,
 * repeats, corrupts or skews anything.
 */
export class GoodEngine implements ChunkPlanner {
  private _params: GoodParams;
  private _noise: NoiseGenerator;

  constructor(params: GoodParams, rng: Rng) {
    this._params = params;
    this._noise = new NoiseGenerator(rng);
  }

  get params(): GoodParams {
    return this._params;
  }

  /**
   * Retunes a running device.
   *
   * The {@link NoiseGenerator} is deliberately *not* replaced: it carries the
   * brown-noise integrator's state, and restarting it on every parameter change
   * would put a seam in the noise floor each time an operator nudged a slider.
   */
  setParams(params: GoodParams): void {
    this._params = params;
  }

  plan(chunk: AudioChunk): ChunkPlan {
    const { gainDb, noiseType, noiseDb } = this._params;

    // The identity case is the common one — an operator watching captions with
    // every knob at its default — and it is worth not decoding and re-encoding
    // a WAV ten times a second to arrive back at the bytes already in hand.
    if (gainDb === 0 && noiseType === 'none') {
      return {
        frames: [plainFrame(chunk.wav)],
        waitMs: chunk.durationMs,
        faulted: false,
      };
    }

    const decoded = decodeWav(chunk.wav);
    // Gain first, then the floor. `noiseDb` is an absolute level, so mixing it
    // in after the trim is what makes -40 dBFS mean -40 dBFS on the meter
    // rather than "-40 dBFS as it would have been before the operator turned
    // the level down".
    let pcm = applyGainDb(decoded.pcm, gainDb);
    if (noiseType !== 'none') {
      pcm = this._noise.mixInto(pcm, noiseType, noiseDb);
    }

    return {
      frames: [plainFrame(encodeWav(pcm, decoded.sampleRate, decoded.channels))],
      waitMs: chunk.durationMs,
      faulted: false,
    };
  }

  /**
   * Never called: this planner marks no frame `corrupt`. Present because the
   * interface is shared, and returning the frame untouched is the only
   * defensible answer if a future caller asks anyway.
   */
  corruptFrame(frame: Uint8Array): Uint8Array {
    return frame;
  }
}

function plainFrame(wav: Buffer) {
  return { wav, reuseChunkId: false, corrupt: false, sentAtSkewMs: 0 };
}
