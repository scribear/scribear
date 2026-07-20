import { describe, expect } from 'vitest';

import { Counter, Histogram } from '#src/server/shared/metrics/metric-types.js';

const NOW = 1_755_624_000_000;

describe('metric types', () => {
  describe('Counter rolling window', (it) => {
    it('counts only increments inside the window', () => {
      // Arrange
      const counter = new Counter('test_total', 'help');

      // Act
      counter.inc({}, 1, NOW - 400_000);
      counter.inc({}, 1, NOW - 1_000);
      counter.inc({}, 1, NOW);

      // Assert — lifetime total keeps everything, the window does not
      expect(counter.total()).toBe(3);
      expect(counter.windowCount({}, 60_000, NOW)).toBe(2);
    });

    it('aggregates across series when matching on a label subset', () => {
      // Arrange
      const counter = new Counter('test_total', 'help');

      // Act
      counter.inc({ service: 'node-server', side: 'a' }, 1, NOW);
      counter.inc({ service: 'node-server', side: 'b' }, 1, NOW);
      counter.inc({ service: 'other', side: 'a' }, 1, NOW);

      // Assert
      expect(counter.windowCount({ service: 'node-server' }, 60_000, NOW)).toBe(
        2,
      );
    });

    it('bounds retained samples so a long-running counter cannot grow forever', () => {
      // Arrange — memory is bounded by arrival rate within the window, not uptime
      const counter = new Counter('test_total', 'help', 10_000);

      // Act
      for (let i = 0; i < 1_000; i++) {
        counter.inc({}, 1, NOW - 100_000 + i);
      }
      counter.inc({}, 1, NOW);

      // Assert — the old samples are pruned, the lifetime value is not
      expect(counter.total()).toBe(1_001);
      expect(counter.windowCount({}, 10_000, NOW)).toBe(1);
    });
  });

  describe('Histogram percentiles', (it) => {
    it('computes exact nearest-rank percentiles', () => {
      // Arrange
      const histogram = new Histogram('test', 'help', [1, 10, 100]);

      // Act
      for (let i = 1; i <= 100; i++) histogram.observe(i);
      const summary = histogram.summary();

      // Assert
      expect(summary?.count).toBe(100);
      expect(summary?.p50).toBe(50);
      expect(summary?.p95).toBe(95);
      expect(summary?.p99).toBe(99);
      expect(summary?.min).toBe(1);
      expect(summary?.max).toBe(100);
    });

    it('reports cumulative bucket counts in le semantics', () => {
      // Arrange
      const histogram = new Histogram('test', 'help', [1, 10, 100]);

      // Act
      histogram.observe(0.5);
      histogram.observe(5);
      histogram.observe(50);

      // Assert — cumulative, so each bucket includes the ones below it
      expect(histogram.bucketCounts()).toStrictEqual([
        { le: 1, count: 1 },
        { le: 10, count: 2 },
        { le: 100, count: 3 },
      ]);
    });

    it('returns undefined for a series with no observations', () => {
      // Arrange
      const histogram = new Histogram('test', 'help', [1]);

      // Act / Assert
      expect(histogram.summary()).toBeUndefined();
    });

    it('drops the oldest observations once the retention cap is reached', () => {
      // Arrange — percentiles should describe recent behaviour, not all history
      const histogram = new Histogram('test', 'help', [1], 10);

      // Act
      for (let i = 0; i < 10; i++) histogram.observe(1);
      for (let i = 0; i < 10; i++) histogram.observe(100);

      // Assert — the count keeps rising, but the retained window is all 100s
      expect(histogram.count()).toBe(20);
      expect(histogram.summary()?.min).toBe(100);
    });
  });
});
