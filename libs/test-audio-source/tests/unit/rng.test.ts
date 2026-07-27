import { describe, expect } from 'vitest';

import { createSeededRng, gaussian } from '#src/rng.js';

/** Enough draws that a mean or variance error above the tolerances would show. */
const DRAWS = 100_000;

function draw(count: number, rng: () => number): number[] {
  return Array.from({ length: count }, () => rng());
}

describe('rng', () => {
  describe('createSeededRng', (it) => {
    it('produces the same sequence for the same seed', () => {
      // Arrange — this is the whole reason the generator is injected. Every
      // fault assertion in this library is of the form "with this seed, these
      // frames are damaged", and that is only meaningful if a seed replays.
      const seed = 0x5c81b3;

      // Act
      const first = draw(16, createSeededRng(seed));
      const second = draw(16, createSeededRng(seed));

      // Assert
      expect(second).toEqual(first);
    });

    it('produces a different sequence for a different seed', () => {
      // Act
      const a = draw(16, createSeededRng(1));
      const b = draw(16, createSeededRng(2));

      // Assert
      expect(b).not.toEqual(a);
    });

    it('stays inside [0, 1) so a percentage gate cannot overshoot', () => {
      // Arrange — `FaultEngine._draw` compares `rng() * 100 < percent`. A value
      // of exactly 1 would make a knob at 100 miss a frame, and a negative one
      // would make a knob at 0 fire.
      const rng = createSeededRng(99);

      // Act
      const values = draw(DRAWS, rng);

      // Assert
      expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...values)).toBeLessThan(1);
    });

    it('is uniform enough to gate a percentage knob', () => {
      // Arrange — the docstring claims nothing beyond this, so neither does the
      // test: the mean of a uniform [0, 1) source is 0.5, and the standard
      // error over 100k draws is under 0.001.
      const values = draw(DRAWS, createSeededRng(4));
      const MEAN_TOLERANCE = 0.005;

      // Act
      const mean = values.reduce((sum, value) => sum + value, 0) / DRAWS;

      // Assert
      expect(mean).toBeCloseTo(0.5, 2);
      expect(Math.abs(mean - 0.5)).toBeLessThan(MEAN_TOLERANCE);
    });
  });

  describe('gaussian', (it) => {
    it('is standard normal, which is what a noise floor actually is', () => {
      // Arrange — thermal and preamp noise are Gaussian; a uniform source would
      // read as artificial on a meter's peak indicator even at the right RMS.
      // The noise generator also divides by this distribution's measured RMS,
      // so a variance far from 1 would not break levels, only the story.
      const rng = createSeededRng(3);
      const MOMENT_TOLERANCE = 0.02;

      // Act
      let sum = 0;
      let sumSquares = 0;
      for (let i = 0; i < DRAWS; i++) {
        const value = gaussian(rng);
        sum += value;
        sumSquares += value * value;
      }
      const mean = sum / DRAWS;
      const variance = sumSquares / DRAWS - mean * mean;

      // Assert
      expect(Math.abs(mean)).toBeLessThan(MOMENT_TOLERANCE);
      expect(Math.abs(variance - 1)).toBeLessThan(MOMENT_TOLERANCE);
    });

    it('never returns a non-finite value', () => {
      // Arrange — mulberry32 can return exactly 0, and `Math.log(0)` is
      // -Infinity. The generator moves the domain to (0, 1] for that reason;
      // one Infinity here would become a whole chunk of digital silence after
      // the noise block's RMS normalisation.
      const rng = createSeededRng(0);

      // Act
      const values = Array.from({ length: DRAWS }, () => gaussian(rng));

      // Assert
      expect(values.every((value) => Number.isFinite(value))).toBe(true);
    });

    it('consumes exactly two draws, so a seeded engine stays replayable', () => {
      // Arrange — the second Box-Muller variate is discarded rather than
      // cached. Caching it would make the output depend on how many samples
      // earlier calls drew, which is the hidden state that makes a seeded test
      // order-dependent.
      const counted = createSeededRng(7);
      let drawn = 0;
      const wrapped = () => {
        drawn++;
        return counted();
      };

      // Act
      gaussian(wrapped);

      // Assert
      expect(drawn).toBe(2);
    });
  });
});
