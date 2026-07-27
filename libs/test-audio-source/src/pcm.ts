/**
 * Signed 16-bit PCM primitives, and the dBFS convention everything else here
 * measures in.
 *
 * Every effect in this library is a `Buffer -> Buffer` transform over
 * little-endian int16 samples, computed in floating point and written back
 * through {@link saturate}. That shape is deliberate:
 *
 * - **Saturation, never wraparound.** `Buffer.writeInt16LE` silently *throws*
 *   out of range and `DataView.setInt16` silently *wraps*, so +20 dB of gain on
 *   a loud fixture would either crash the stream or turn its loudest peaks into
 *   full-scale samples of the opposite sign — an unmistakable buzz that an
 *   operator would report as a pipeline fault. Real converters clip; so does
 *   this.
 * - **One conversion per effect, not one per pipeline.** Chaining four
 *   `Buffer -> Buffer` passes over a 100 ms chunk is ~6400 float operations ten
 *   times a second. That is nothing, and it buys effects that can each be
 *   tested in isolation against a measured signal.
 */

/** Most negative representable sample. */
export const INT16_MIN = -32_768;
/** Most positive representable sample. */
export const INT16_MAX = 32_767;
export const BYTES_PER_SAMPLE = 2;

/**
 * The 0 dBFS reference.
 *
 * 32768 (not 32767), so `INT16_MIN` is exactly -1.0 and a full-scale square
 * wave measures 0.0 dBFS. This matches the convention the standalone audio
 * meter and the transcription service's ingress meter both use — they read
 * float samples normalised to [-1, 1] — so a level requested here is the level
 * that appears on those readouts.
 */
export const FULL_SCALE = 32_768;

/** Rounds to the nearest integer sample and clamps into int16 range. */
export function saturate(value: number): number {
  const rounded = Math.round(value);
  if (rounded > INT16_MAX) return INT16_MAX;
  if (rounded < INT16_MIN) return INT16_MIN;
  return rounded;
}

/** Number of whole int16 samples in `pcm`. */
export function sampleCount(pcm: Buffer): number {
  return Math.floor(pcm.length / BYTES_PER_SAMPLE);
}

/** Decodes int16 PCM into normalised floats in [-1, 1]. */
export function toFloat(pcm: Buffer): Float64Array {
  const count = sampleCount(pcm);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = pcm.readInt16LE(i * BYTES_PER_SAMPLE) / FULL_SCALE;
  }
  return out;
}

/** Encodes normalised floats back to int16 PCM, saturating at the rails. */
export function fromFloat(samples: Float64Array): Buffer {
  const out = Buffer.alloc(samples.length * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples.length; i++) {
    out.writeInt16LE(saturate((samples[i] ?? 0) * FULL_SCALE), i * BYTES_PER_SAMPLE);
  }
  return out;
}

/**
 * Root-mean-square level of `pcm` in dBFS.
 *
 * Returns `-Infinity` for digital silence rather than `NaN` or a floor value:
 * silence has no level, and a caller comparing against a threshold gets the
 * right answer from `-Infinity` without a special case.
 */
export function rmsDbfs(pcm: Buffer): number {
  const count = sampleCount(pcm);
  if (count === 0) return Number.NEGATIVE_INFINITY;

  let sumSquares = 0;
  for (let i = 0; i < count; i++) {
    const sample = pcm.readInt16LE(i * BYTES_PER_SAMPLE) / FULL_SCALE;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / count);
  return rms === 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(rms);
}

/** Mean sample value, normalised to [-1, 1]. This is the DC component. */
export function dcOffsetOf(pcm: Buffer): number {
  const count = sampleCount(pcm);
  if (count === 0) return 0;

  let sum = 0;
  for (let i = 0; i < count; i++) {
    sum += pcm.readInt16LE(i * BYTES_PER_SAMPLE) / FULL_SCALE;
  }
  return sum / count;
}

/** Largest absolute sample value, normalised to [-1, 1]. */
export function peakOf(pcm: Buffer): number {
  const count = sampleCount(pcm);
  let peak = 0;
  for (let i = 0; i < count; i++) {
    const magnitude = Math.abs(pcm.readInt16LE(i * BYTES_PER_SAMPLE)) / FULL_SCALE;
    if (magnitude > peak) peak = magnitude;
  }
  return peak;
}

/** Converts a decibel figure to the linear amplitude factor it names. */
export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}
