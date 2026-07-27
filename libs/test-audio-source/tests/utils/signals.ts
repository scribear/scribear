/**
 * Signal generators and measurements the DSP suites assert against.
 *
 * Deliberately independent of `src/pcm.ts`: a test that measured the output
 * with the same helper the effect used to produce it would agree with itself
 * whatever either one did. These read the buffer byte by byte.
 */
import {
  type AudioChunk,
  decodeWav,
  encodeWav,
  sliceIntoChunks,
} from '#src/wav.js';

/** The rate every fixture and every synthetic source in the stack runs at. */
export const SAMPLE_RATE = 16_000;
/** Chunk size a real source device emits, and the one the streamer paces to. */
export const CHUNK_MS = 100;

/**
 * A sine at `amplitude` of full scale.
 *
 * A tone rather than noise because every level assertion here is about an
 * *exact* number: a tone's RMS is `amplitude / sqrt(2)` analytically, so a gain
 * test that comes out 0.02 dB off is measuring the effect and not the fixture.
 */
export function sine(
  frames: number,
  hz: number,
  amplitude: number,
  sampleRate = SAMPLE_RATE,
): Buffer {
  const pcm = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const value =
      amplitude * 32_768 * Math.sin((2 * Math.PI * hz * i) / sampleRate);
    pcm.writeInt16LE(
      Math.max(-32_768, Math.min(32_767, Math.round(value))),
      i * 2,
    );
  }
  return pcm;
}

/** `frames` of digital silence. */
export function silentPcm(frames: number): Buffer {
  return Buffer.alloc(frames * 2);
}

/** Every sample of `pcm`, as plain numbers. */
export function samplesOf(pcm: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < pcm.length; i += 2) out.push(pcm.readInt16LE(i));
  return out;
}

/** Smallest and largest sample, for range and saturation assertions. */
export function sampleRange(pcm: Buffer): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const sample of samplesOf(pcm)) {
    if (sample < min) min = sample;
    if (sample > max) max = sample;
  }
  return { min, max };
}

/**
 * Number of samples whose sign flipped between `before` and `after`.
 *
 * This is the wraparound detector. Saturation can only ever move a sample
 * *toward* a rail of the same sign, so any amplifying transform that flips a
 * sign has wrapped — the exact failure that turns a hot microphone into an
 * audible buzz. Samples that were zero are skipped: they have no sign to keep.
 */
export function signFlips(before: Buffer, after: Buffer): number {
  const a = samplesOf(before);
  const b = samplesOf(after);
  let flips = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const from = a[i] ?? 0;
    const to = b[i] ?? 0;
    if (from === 0 || to === 0) continue;
    if (from > 0 !== to > 0) flips++;
  }
  return flips;
}

/**
 * Energy in the first difference of `pcm`, as a fraction of its total energy.
 *
 * The chosen brown-vs-white discriminator, and it is a spectral measure in
 * disguise: differencing is a first-order high-pass, so this ratio is
 * `2 * (1 - r)` for a signal whose normalised autocorrelation at lag 1 is `r`,
 * which is a monotone function of the spectral centroid. White noise is
 * uncorrelated sample to sample (`r = 0`) and lands at 2.0; the brown
 * generator's leaky integrator has `r` just under its leak coefficient, putting
 * it near 0.01. Preferred over a DFT because it needs no window, no bin
 * bookkeeping and no tolerance on where the centroid "should" be — the two
 * colours are two orders of magnitude apart on it.
 *
 * Returns 0 for digital silence, which has no energy to apportion.
 */
export function diffEnergyRatio(pcm: Buffer): number {
  const samples = samplesOf(pcm);
  let differenceEnergy = 0;
  let totalEnergy = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] ?? 0;
    totalEnergy += value * value;
    if (i > 0) {
      const delta = value - (samples[i - 1] ?? 0);
      differenceEnergy += delta * delta;
    }
  }
  return totalEnergy === 0 ? 0 : differenceEnergy / totalEnergy;
}

/** Wraps raw PCM the way a real source device would, then slices it. */
export function chunksOf(pcm: Buffer, chunkMs = CHUNK_MS): AudioChunk[] {
  return sliceIntoChunks(decodeWav(encodeWav(pcm, SAMPLE_RATE, 1)), chunkMs);
}

/** The first chunk of `pcm`, for effects that only need one. */
export function oneChunk(pcm: Buffer): AudioChunk {
  const chunks = chunksOf(pcm);
  const first = chunks[0];
  if (first === undefined) throw new Error('No chunks produced.');
  return first;
}
