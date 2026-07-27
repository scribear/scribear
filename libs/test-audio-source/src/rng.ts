/**
 * The random source every probabilistic knob draws from.
 *
 * Injected rather than reached for, so a fault engine can be driven with a
 * fixed seed in tests. `Math.random` cannot be seeded, and a fault engine whose
 * behaviour is only assertable in aggregate ("about 30% of frames were
 * dropped") is a flaky test waiting to happen — the interesting assertions are
 * about the *exact* sequence of decisions a given seed produces.
 *
 * Contract: returns a float in `[0, 1)`, the same as `Math.random`.
 */
export type Rng = () => number;

/**
 * Seeded PRNG (mulberry32).
 *
 * Chosen for being 8 lines with no state beyond one 32-bit word and a period
 * long enough (2^32) that no run of this service can exhaust it: at 10 frames
 * per second drawing ~6 values each, that is over two years. Statistical
 * quality beyond "uniform enough to gate a fault knob" is not needed and is not
 * claimed — this must never be used for anything security-bearing.
 */
export function createSeededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * Draws a standard normal sample from a uniform source (Box-Muller).
 *
 * Gaussian rather than uniform because that is what a noise *floor* is: thermal
 * and preamp noise are Gaussian, and a uniform generator would produce a signal
 * with a hard amplitude ceiling that reads as artificial on a meter's peak
 * indicator even when its RMS is correct.
 *
 * The second variate of the pair is discarded rather than cached. Caching would
 * make the generator's output depend on how many samples were drawn in previous
 * calls, which is exactly the hidden state that makes a seeded test
 * order-dependent.
 */
export function gaussian(rng: Rng): number {
  // `1 - rng()` moves the domain to (0, 1], keeping `log` finite: mulberry32
  // can return exactly 0.
  const u = 1 - rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
