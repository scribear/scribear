import { describe, expect } from 'vitest';

import { AlertEvaluatorService } from '#src/server/shared/alerts/alert-evaluator.service.js';
import { DEFAULT_THRESHOLDS } from '#src/server/shared/alerts/alert-rules.js';
import type { CanaryRunnerService } from '#src/server/shared/canary/canary-runner.service.js';
import { LogIngestService } from '#src/server/shared/log-ingest/log-ingest.service.js';
import type { RawLogLine } from '#src/server/shared/log-ingest/log-ingest.service.js';
import { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';
import { buildSnapshot } from '#src/server/shared/metrics/snapshot-builder.js';
import type {
  ProbePollerService,
  ProbeStatus,
} from '#src/server/shared/probes/probe-poller.service.js';
import {
  CONFIG_STREAM_URL,
  incomingRequest,
  requestCompleted,
  upstreamState,
} from '#tests/fixtures/log-lines.js';

const START_MS = 1_755_624_000_000;

function createStack(probes: ProbeStatus[] = []) {
  const metrics = new MetricsRegistry();
  const logger = {
    warn: () => undefined,
    info: () => undefined,
    error: () => undefined,
  } as never;
  const ingest = new LogIngestService(metrics, logger, {
    jobPeriodMs: 1_000,
    configStreamUrlFragment: '/session-config-stream/',
  });
  const probePoller = { statuses: () => probes } as ProbePollerService;
  // The canary is irrelevant to log replay; a runner that has never produced a
  // result keeps the canary rules inert without stubbing the whole service.
  const canaryRunner = { lastResult: null } as CanaryRunnerService;
  const evaluator = new AlertEvaluatorService(
    metrics,
    probePoller,
    canaryRunner,
    DEFAULT_THRESHOLDS,
  );
  return { metrics, ingest, evaluator };
}

/**
 * Synthesizes the BUG.txt failure: node-server's upstream link to
 * transcription-service repeatedly opens and drops while the session still
 * reports as running.
 *
 * Each cycle is one full reconnect: OPEN is lost, the client waits, retries,
 * handshakes, and comes back up — then loses it again.
 */
function flapPattern(cycles: number, startMs: number, stepMs: number) {
  const lines: RawLogLine[] = [];
  let t = startMs;
  const step = () => {
    t += stepMs;
    return t;
  };

  // Healthy start.
  lines.push(upstreamState('IDLE', 'CONNECTING', 'sess-flap', step()));
  lines.push(upstreamState('CONNECTING', 'HANDSHAKING', 'sess-flap', step()));
  lines.push(upstreamState('HANDSHAKING', 'OPEN', 'sess-flap', step()));

  for (let i = 0; i < cycles; i++) {
    lines.push(upstreamState('OPEN', 'WAITING_RETRY', 'sess-flap', step()));
    lines.push(
      upstreamState('WAITING_RETRY', 'CONNECTING', 'sess-flap', step()),
    );
    lines.push(upstreamState('CONNECTING', 'HANDSHAKING', 'sess-flap', step()));
    lines.push(upstreamState('HANDSHAKING', 'OPEN', 'sess-flap', step()));
  }
  return lines;
}

describe('BUG.txt upstream flap replay', () => {
  describe('N1 detection from logs alone', (it) => {
    it('raises a critical N1 alert within 30 seconds of the flap starting', () => {
      // Arrange — the acceptance bound from PLAN-MONITORING-DASHBOARD.md §5 A1:
      // "the collector flags N1 within 30 s, from logs alone". Flap every 5s.
      const { ingest, evaluator } = createStack();
      const lines = flapPattern(4, START_MS, 5_000);

      // Act
      ingest.ingestAll(lines);
      const evaluatedAt = START_MS + 30_000;
      const alerts = evaluator.evaluate(evaluatedAt);

      // Assert
      const n1 = alerts.find((a) => a.failureModes.includes('N1'));
      expect(n1).toBeDefined();
      expect(n1?.severity).toBe('critical');
      expect(n1?.summary).toContain('sess-flap');
    });

    it('stays silent for a healthy session over the same period', () => {
      // Arrange — the do-no-false-alarm side of the gate
      const { ingest, evaluator } = createStack();

      // Act
      ingest.ingestAll(flapPattern(0, START_MS, 5_000));
      const alerts = evaluator.evaluate(START_MS + 30_000);

      // Assert
      expect(alerts.filter((a) => a.failureModes.includes('N1'))).toHaveLength(
        0,
      );
    });

    it('isolates the flapping session from healthy ones', () => {
      // Arrange — a real deployment runs many rooms at once
      const { ingest, evaluator } = createStack();
      let t = START_MS;
      for (let i = 0; i < 4; i++) {
        t += 5_000;
        ingest.ingest(upstreamState('OPEN', 'WAITING_RETRY', 'sess-bad', t));
        ingest.ingest(upstreamState('HANDSHAKING', 'OPEN', 'sess-good', t));
      }

      // Act
      const alerts = evaluator
        .evaluate(START_MS + 30_000)
        .filter((a) => a.failureModes.includes('N1'));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.summary).toContain('sess-bad');
      expect(alerts[0]?.summary).not.toContain('sess-good');
    });
  });

  describe('correlated N2 root cause', (it) => {
    it('surfaces the secret-drift 401 alongside the churn it causes', () => {
      // Arrange — the ISSUES-To-Review.md cross-wiring: the config long poll is
      // rejected, so the session never gets its config and the upstream churns.
      // Both alerts should fire, and the N2 one names the actual root cause.
      const { ingest, evaluator } = createStack();
      let t = START_MS;
      for (let i = 0; i < 4; i++) {
        t += 5_000;
        ingest.ingest(
          incomingRequest(
            `req-${String(i)}`,
            CONFIG_STREAM_URL,
            'session-manager',
            t,
          ),
        );
        ingest.ingest(
          requestCompleted(`req-${String(i)}`, 401, 'session-manager', t),
        );
        ingest.ingest(upstreamState('OPEN', 'WAITING_RETRY', 'sess-flap', t));
      }

      // Act
      const alerts = evaluator.evaluate(START_MS + 30_000);

      // Assert
      const modes = alerts.flatMap((a) => a.failureModes);
      expect(modes).toContain('N1');
      expect(modes).toContain('N2');

      const n2 = alerts.find((a) => a.failureModes.includes('N2'));
      expect(n2?.likelyCause).toContain('API key');
    });
  });

  describe('snapshot output', (it) => {
    it('exposes the firing alert and the churn counter to the SPA', () => {
      // Arrange
      const { metrics, ingest, evaluator } = createStack();
      ingest.ingestAll(flapPattern(4, START_MS, 5_000));
      const at = START_MS + 30_000;

      // Act
      const snapshot = buildSnapshot(
        metrics,
        [],
        evaluator.evaluate(at),
        null,
        DEFAULT_THRESHOLDS.rateWindowMs,
        at,
      );

      // Assert
      expect(snapshot.alerts.length).toBeGreaterThan(0);
      const churn = snapshot.counters['scribear_node_upstream_churn_total'];
      expect(churn?.[0]?.value).toBe(4);
      // Ingest self-observability: everything replayed was understood.
      expect(snapshot.ingest.unparsedTotal).toBe(0);
      expect(snapshot.ingest.parsedTotal).toBeGreaterThan(0);
    });
  });
});
