import {
  BYTES_PER_SAMPLE,
  FULL_SCALE,
  INT16_MAX,
  INT16_MIN,
  dbToLinear,
  fromFloat,
  sampleCount,
  saturate,
  toFloat,
} from './pcm.js';
import { type Rng, gaussian } from './rng.js';

/**
 * Waveform effects, all `Buffer -> Buffer` over little-endian int16 PCM.
 *
 * Each is a separate exported function rather than one fused pipeline so each
 * can be measured on its own: the gate for this module is "20 dB of gain raises
 * the measured RMS by 20 dB", not "the pipeline called applyGainDb".
 */

/**
 * Applies a level trim, saturating at the rails.
 *
 * Exactly linear in dB while the result fits — `+6 dB` raises the measured RMS
 * by 6.00 dB — and clips rather than wraps when it does not. That second half
 * is the whole reason this is not one multiply: `+20 dB` on a fixture that
 * already peaks near full scale is a *supported* setting whose intended
 * observable is clipping, and a wraparound would instead produce full-scale
 * samples of the opposite sign, which sounds like a broken decoder rather than
 * a hot microphone.
 */
export function applyGainDb(pcm: Buffer, gainDb: number): Buffer {
  if (gainDb === 0) return pcm;

  const factor = dbToLinear(gainDb);
  const count = sampleCount(pcm);
  const out = Buffer.alloc(count * BYTES_PER_SAMPLE);
  for (let i = 0; i < count; i++) {
    const offset = i * BYTES_PER_SAMPLE;
    out.writeInt16LE(saturate(pcm.readInt16LE(offset) * factor), offset);
  }
  return out;
}

/**
 * Adds a constant DC bias, as a fraction of full scale.
 *
 * Applied *after* any clipping so the bias survives: clipping a biased
 * waveform would push the offset back toward zero on whichever rail it ran
 * into, and the knob would silently do less than it says at high levels.
 *
 * Known gap, and it is not this function's: **nothing in the stack measures
 * DC.** The ingress meter reports RMS, peak, clipping, silence and noise floor,
 * and no DC or bias field exists on any telemetry surface. A bias is therefore
 * only visible indirectly, as inflated RMS and peak. The knob is still worth
 * having — it is the cheapest way to produce that inflation without touching
 * the speech — but an operator should not expect a dedicated readout.
 */
export function applyDcOffset(pcm: Buffer, dcOffset: number): Buffer {
  if (dcOffset === 0) return pcm;

  const bias = dcOffset * FULL_SCALE;
  const count = sampleCount(pcm);
  const out = Buffer.alloc(count * BYTES_PER_SAMPLE);
  for (let i = 0; i < count; i++) {
    const offset = i * BYTES_PER_SAMPLE;
    out.writeInt16LE(saturate(pcm.readInt16LE(offset) + bias), offset);
  }
  return out;
}

/** A chunk of digital silence, byte-for-byte the length of the one it replaces. */
export function digitalSilence(byteLength: number): Buffer {
  return Buffer.alloc(byteLength);
}

/**
 * Drives `clipPct` percent of the chunk's samples into full-scale clipping.
 *
 * **Why a target share rather than a threshold.** The obvious reading of
 * "hard-clip the waveform" is a ceiling knob — clamp at `(1 - pct)` of full
 * scale — and it is the wrong one for what this exists to trip. The ingress
 * meter's clipping detector counts samples **at the rail**
 * (`|sample| >= 0.99`, in runs of at least 2), so a waveform clamped hard at,
 * say, half scale is not clipped as far as any telemetry in the stack is
 * concerned: it is just quiet and square. Clipping that nothing reports is not
 * a fault an operator can go and look at.
 *
 * So this instead finds the gain that puts the `(100 - clipPct)`th percentile
 * of `|sample|` exactly at full scale, applies it, and lets {@link saturate}
 * clip the rest. The result is that about `clipPct` percent of samples sit on
 * the rail — which is, near enough, the number the meter's `clippingPct` will
 * report back. Saturating a *continuous* waveform necessarily produces runs of
 * consecutive rail samples, so the detector's run-length requirement is met
 * for free.
 *
 * Zero is a hard no-op rather than a limiting case: at `clipPct = 0` the
 * percentile is the chunk's peak, and normalising a quiet fixture up to full
 * scale would be a large audible change made by a knob set to "off".
 */
export function hardClipToRail(pcm: Buffer, clipPct: number): Buffer {
  if (clipPct <= 0) return pcm;

  const count = sampleCount(pcm);
  if (count === 0) return pcm;

  const magnitudes = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    magnitudes[i] = Math.abs(pcm.readInt16LE(i * BYTES_PER_SAMPLE));
  }
  magnitudes.sort();

  // Index of the sample that should land exactly on the rail. At clipPct = 100
  // this is the quietest sample in the chunk, so everything above it — i.e.
  // everything — saturates.
  const index = Math.min(
    count - 1,
    Math.max(0, Math.round(((100 - clipPct) / 100) * (count - 1))),
  );
  // Floored at one LSB so an all-silent or near-silent chunk cannot ask for
  // infinite gain. Silence stays silent (0 * anything is 0), which is correct:
  // there is no waveform there to clip.
  const pivot = Math.max(1, magnitudes[index] ?? 1);
  const factor = INT16_MAX / pivot;

  const out = Buffer.alloc(count * BYTES_PER_SAMPLE);
  for (let i = 0; i < count; i++) {
    const offset = i * BYTES_PER_SAMPLE;
    out.writeInt16LE(saturate(pcm.readInt16LE(offset) * factor), offset);
  }
  return out;
}

/** Share of samples sitting on either rail. The meter's `clippingPct`, roughly. */
export function clippedFraction(pcm: Buffer): number {
  const count = sampleCount(pcm);
  if (count === 0) return 0;

  let clipped = 0;
  for (let i = 0; i < count; i++) {
    const sample = pcm.readInt16LE(i * BYTES_PER_SAMPLE);
    if (sample >= INT16_MAX || sample <= INT16_MIN) clipped++;
  }
  return clipped / count;
}

/**
 * Leak coefficient of the brown-noise integrator.
 *
 * True Brownian motion is a pure integrator (`b[n] = b[n-1] + w[n]`), whose
 * variance grows without bound and whose output is dominated by a DC-ward
 * random walk. Leaking makes it a one-pole low-pass at
 * `(1 - LEAK) * fs / 2pi` — about 12.7 Hz at 16 kHz — so the spectrum is flat
 * below that and falls at 6 dB/octave above it. That is brown where it matters
 * (the audio band) and bounded where it does not, and it keeps the wander out
 * of the DC knob's territory: DC offset is a separate parameter and this must
 * not quietly supply one.
 */
const BROWN_LEAK = 0.995;

/**
 * Generates and mixes in a noise floor at a requested absolute level.
 *
 * Stateful, and must be: brown noise is defined by its history, so a generator
 * recreated per 100 ms chunk would restart the integrator ten times a second
 * and produce something with a brown spectrum only up to 100 ms — audibly and
 * measurably closer to white. One instance lives for the length of a run.
 */
export class NoiseGenerator {
  private _rng: Rng;
  private _brownState = 0;

  constructor(rng: Rng) {
    this._rng = rng;
  }

  /**
   * Mixes a noise floor of `dbfs` into `pcm`.
   *
   * The level is **absolute**, not relative to the signal, and the mix happens
   * after any gain trim: an operator who asks for a -40 dBFS floor wants the
   * meter to read a -40 dBFS floor, whatever the speech is doing. Summing
   * saturates, so a floor mixed into already-clipped audio cannot wrap.
   */
  mixInto(pcm: Buffer, type: 'white' | 'brown', dbfs: number): Buffer {
    const count = sampleCount(pcm);
    if (count === 0) return pcm;

    const noise = this._generate(count, type);
    const target = dbToLinear(dbfs);

    // Normalised per block so the requested level is *exact* on the readout
    // rather than exact in expectation. The alternative — scaling by the
    // process's theoretical standard deviation — leaves a block-to-block RMS
    // jitter of most of a dB for brown noise, whose correlation time is a
    // meaningful fraction of a 100 ms chunk. An operator turning a floor knob
    // and watching a meter is entitled to see the number they asked for.
    let sumSquares = 0;
    for (let i = 0; i < count; i++) {
      const value = noise[i] ?? 0;
      sumSquares += value * value;
    }
    const rms = Math.sqrt(sumSquares / count);
    if (rms === 0) return pcm;
    const scale = target / rms;

    const samples = toFloat(pcm);
    for (let i = 0; i < count; i++) {
      samples[i] = (samples[i] ?? 0) + (noise[i] ?? 0) * scale;
    }
    return fromFloat(samples);
  }

  /** Raw, unnormalised noise of the requested colour. */
  private _generate(count: number, type: 'white' | 'brown'): Float64Array {
    const out = new Float64Array(count);
    if (type === 'white') {
      for (let i = 0; i < count; i++) out[i] = gaussian(this._rng);
      return out;
    }

    let state = this._brownState;
    for (let i = 0; i < count; i++) {
      state = BROWN_LEAK * state + gaussian(this._rng);
      out[i] = state;
    }
    this._brownState = state;
    return out;
  }
}
