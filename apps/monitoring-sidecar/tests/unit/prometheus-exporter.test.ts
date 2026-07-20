import { describe, expect } from 'vitest';

import { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';
import { renderPrometheus } from '#src/server/shared/metrics/prometheus-exporter.js';

describe('prometheus exporter', () => {
  describe('exposition format', (it) => {
    it('emits HELP and TYPE headers for a counter', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      metrics.safpDecodeDropsTotal.inc({
        service: 'node-server',
        side: 'node',
      });

      // Act
      const text = renderPrometheus(metrics);

      // Assert
      expect(text).toContain('# TYPE scribear_safp_decode_drops_total counter');
      expect(text).toContain(
        'scribear_safp_decode_drops_total{service="node-server",side="node"} 1',
      );
    });

    it('escapes quotes in label values so a scrape cannot be broken', () => {
      // Arrange — close reasons flow straight into a label and are attacker-
      // adjacent (they originate from client-driven close paths).
      const metrics = new MetricsRegistry();
      metrics.wsCloseTotal.inc({ reason: 'say "hi"\\n' });

      // Act
      const text = renderPrometheus(metrics);

      // Assert
      expect(text).toContain('reason="say \\"hi\\"\\\\n"');
    });

    it('emits the mandatory +Inf bucket matching the observation count', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      metrics.canaryTimeToFirstTranscriptMs.observe(120, { room: 'canary' });
      metrics.canaryTimeToFirstTranscriptMs.observe(9_000, { room: 'canary' });

      // Act
      const text = renderPrometheus(metrics);

      // Assert — a histogram without +Inf is rejected by scrapers
      expect(text).toContain(
        'scribear_canary_time_to_first_transcript_ms_bucket{room="canary",le="+Inf"} 2',
      );
      expect(text).toContain(
        'scribear_canary_time_to_first_transcript_ms_count{room="canary"} 2',
      );
    });

    it('sorts labels so a series key is stable regardless of insertion order', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      metrics.safpDecodeDropsTotal.inc({
        side: 'node',
        service: 'node-server',
      });
      metrics.safpDecodeDropsTotal.inc({
        service: 'node-server',
        side: 'node',
      });

      // Act
      const text = renderPrometheus(metrics);
      const matches = text
        .split('\n')
        .filter((l) => l.startsWith('scribear_safp_decode_drops_total{'));

      // Assert — one series with value 2, not two series with value 1
      expect(matches).toHaveLength(1);
      expect(matches[0]).toContain(' 2');
    });

    it('ends with a newline', () => {
      // Arrange
      const metrics = new MetricsRegistry();

      // Act
      const text = renderPrometheus(metrics);

      // Assert
      expect(text.endsWith('\n')).toBe(true);
    });
  });
});
