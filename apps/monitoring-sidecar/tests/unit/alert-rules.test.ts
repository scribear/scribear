import { describe, expect } from 'vitest';

import {
  type AlertContext,
  AlertSeverity,
  type AlertThresholds,
  DEFAULT_THRESHOLDS,
  PipelineStage,
  authFailureRule,
  canaryFailureRule,
  canaryQualityRule,
  configPollErrorRule,
  decodeDropRule,
  nodeStatusUnavailableRule,
  probeDownRule,
  transcriptionSaturationRule,
  upstreamChurnRule,
} from '#src/server/shared/alerts/alert-rules.js';
import {
  CanaryOutcome,
  type CanaryRunResult,
} from '#src/server/shared/canary/canary-types.js';
import { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';
import type { ProbeStatus } from '#src/server/shared/probes/probe-poller.service.js';

const NOW = 1_755_624_000_000;

function context(
  metrics: MetricsRegistry,
  probes: ProbeStatus[] = [],
  overrides: Partial<AlertThresholds> = {},
  canary: CanaryRunResult | null = null,
): AlertContext {
  return {
    metrics,
    probes,
    canary,
    nowMs: NOW,
    thresholds: { ...DEFAULT_THRESHOLDS, ...overrides },
  };
}

/** A healthy canary run, so each test varies only the field it is about. */
function canaryResult(
  overrides: Partial<CanaryRunResult> = {},
): CanaryRunResult {
  return {
    outcome: CanaryOutcome.OK,
    startedAtMs: NOW,
    durationMs: 40_000,
    sessionUid: 'sess-canary',
    error: null,
    timeToFirstTranscriptMs: 2_000,
    transcriptCount: 25,
    chunksSent: 400,
    transcriptText: 'the birch canoe slid on the smooth planks',
    accuracy: {
      recall: 1,
      precision: 1,
      f1: 1,
      missing: [],
      expectedWordCount: 5,
      actualWordCount: 5,
    },
    repetitionRatio: 0.05,
    pipelineMsP50: 120,
    pipelineMsP95: 200,
    e2eMsP95: 260,
    clockSyncEstablished: true,
    transcriptionServiceConnected: true,
    sourceDeviceConnected: true,
    closeCodes: [],
    ...overrides,
  };
}

function probe(overrides: Partial<ProbeStatus> = {}): ProbeStatus {
  return {
    service: 'session-manager',
    probe: 'readiness',
    healthy: false,
    statusCode: 503,
    latencyMs: 3,
    checks: null,
    error: 'HTTP 503',
    consecutiveFailures: 3,
    lastCheckedMs: NOW,
    ...overrides,
  };
}

describe('alert rules', () => {
  describe('upstream churn (N1)', (it) => {
    it('stays silent below the threshold', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      metrics.upstreamChurnTotal.inc({ service: 'node-server' }, 1, NOW);

      // Act
      const alerts = upstreamChurnRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('fires once churn crosses the threshold, naming the affected session', () => {
      // Arrange - the counter is process-wide since B1.1, so the room is named
      // from the per-session upstream gauge rather than from a counter label.
      const metrics = new MetricsRegistry();
      for (let i = 0; i < 4; i++) {
        metrics.upstreamChurnTotal.inc({ service: 'node-server' }, 1, NOW - i);
      }
      metrics.nodeSessionUpstreamUp.set(
        { service: 'node-server', sessionUid: 'sess-1' },
        0,
      );

      // Act
      const alerts = upstreamChurnRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.severity).toBe(AlertSeverity.CRITICAL);
      expect(alerts[0]?.failureModes).toContain('N1');
      expect(alerts[0]?.summary).toContain('sess-1');
      // Every red state must name a next action, not just a number.
      expect(alerts[0]?.likelyCause).toContain('session-config-stream');
    });

    it('still fires when no session is currently down', () => {
      // Arrange - a link that flapped and recovered between polls leaves churn
      // in the window but nothing to name. The count is what fires the rule.
      const metrics = new MetricsRegistry();
      for (let i = 0; i < 4; i++) {
        metrics.upstreamChurnTotal.inc({ service: 'node-server' }, 1, NOW - i);
      }

      // Act
      const alerts = upstreamChurnRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.summary).toContain('across all sessions');
    });

    it('ignores churn that has aged out of the rate window', () => {
      // Arrange — old enough to fall outside the window
      const metrics = new MetricsRegistry();
      for (let i = 0; i < 5; i++) {
        metrics.upstreamChurnTotal.inc(
          { service: 'node-server' },
          1,
          NOW - 10 * 60_000,
        );
      }

      // Act
      const alerts = upstreamChurnRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });
  });

  describe('config poll errors (N2/S3)', (it) => {
    it('fires on a single auth failure', () => {
      // Arrange — any 401 here means sessions cannot get their config at all
      const metrics = new MetricsRegistry();
      metrics.smConfigPollErrorsTotal.inc({ status: '401' }, 1, NOW);

      // Act
      const alerts = configPollErrorRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.failureModes).toEqual(['N2', 'S3']);
    });
  });

  describe('transcription saturation (T1)', (it) => {
    it('fires when p95 period utilization reaches the saturation line', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      for (let i = 0; i < 20; i++) {
        metrics.asrPeriodUtilization.observe(1.4, { providerKey: 'whisper' });
      }

      // Act
      const alerts = transcriptionSaturationRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.stage).toBe('transcription');
    });

    it('stays silent for a comfortably-under-period workload', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      for (let i = 0; i < 20; i++) {
        metrics.asrPeriodUtilization.observe(0.4, { providerKey: 'whisper' });
      }

      // Act
      const alerts = transcriptionSaturationRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });
  });

  describe('decode drops (U2/S4)', (it) => {
    it('fires once drops exceed the threshold in the window', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      for (let i = 0; i < 12; i++) {
        metrics.safpDecodeDropsTotal.inc({ side: 'node' }, 1, NOW);
      }

      // Act
      const alerts = decodeDropRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.likelyCause).toContain('version');
    });
  });

  describe('auth failure ratio (S2)', (it) => {
    it('ignores a few expired tokens amid healthy traffic', () => {
      // Arrange — background noise, not a config failure
      const metrics = new MetricsRegistry();
      metrics.wsCloseTotal.inc({ reason: 'token-expired' }, 1, NOW);
      for (let i = 0; i < 19; i++) {
        metrics.wsCloseTotal.inc({ reason: 'no-more-sources' }, 1, NOW);
      }

      // Act
      const alerts = authFailureRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('fires when nearly every close is an auth rejection', () => {
      // Arrange — the signing-key mismatch signature
      const metrics = new MetricsRegistry();
      for (let i = 0; i < 20; i++) {
        metrics.wsCloseTotal.inc({ reason: 'invalid-token' }, 1, NOW);
      }

      // Act
      const alerts = authFailureRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.likelyCause).toContain('SESSION_TOKEN_SIGNING_KEY');
    });

    it('does not fire on a tiny sample', () => {
      // Arrange — one rejection out of one close is 100% but meaningless
      const metrics = new MetricsRegistry();
      metrics.wsCloseTotal.inc({ reason: 'invalid-token' }, 1, NOW);

      // Act
      const alerts = authFailureRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });
  });

  describe('node status unavailable', (it) => {
    it('stays silent while the status poll is succeeding', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      metrics.nodeStatusUp.set({ service: 'node-server' }, 1);

      // Act
      const alerts = nodeStatusUnavailableRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('escalates a rejected service key to critical', () => {
      // Arrange - the blind spot the B1.1 cut-over introduced: node-server is
      // healthy, every probe is green, and four metrics silently report zero.
      const metrics = new MetricsRegistry();
      metrics.nodeStatusUp.set({ service: 'node-server' }, 0);
      metrics.nodeStatusPollErrorsTotal.inc(
        { service: 'node-server', reason: 'unauthorized' },
        1,
        NOW,
      );

      // Act
      const alerts = nodeStatusUnavailableRule(context(metrics));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.severity).toBe(AlertSeverity.CRITICAL);
      expect(alerts[0]?.likelyCause).toContain('NODE_SERVER_SERVICE_API_KEY');
    });

    it('warns rather than pages when the endpoint is merely unreachable', () => {
      // Arrange - the probe poller already alerts on an unreachable service, so
      // this would be the second alert for one outage.
      const metrics = new MetricsRegistry();
      metrics.nodeStatusUp.set({ service: 'node-server' }, 0);
      metrics.nodeStatusPollErrorsTotal.inc(
        { service: 'node-server', reason: 'unreachable' },
        1,
        NOW,
      );

      // Act
      const alerts = nodeStatusUnavailableRule(context(metrics));

      // Assert
      expect(alerts[0]?.severity).toBe(AlertSeverity.WARNING);
      expect(alerts[0]?.stage).toBe(PipelineStage.CONTROL_PLANE);
    });
  });

  describe('probe down (N5/S1/T9)', (it) => {
    it('tolerates a single failed poll', () => {
      // Arrange
      const metrics = new MetricsRegistry();

      // Act
      const alerts = probeDownRule(
        context(metrics, [probe({ consecutiveFailures: 1 })]),
      );

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('names the failing dependency when readiness reports checks', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      const status = probe({ checks: { database: 'fail' } });

      // Act
      const alerts = probeDownRule(context(metrics, [status]));

      // Assert — "session-manager is down because the database is"
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.likelyCause).toContain('database');
    });

    it('ignores healthy probes', () => {
      // Arrange
      const metrics = new MetricsRegistry();

      // Act
      const alerts = probeDownRule(
        context(metrics, [probe({ healthy: true, consecutiveFailures: 0 })]),
      );

      // Assert
      expect(alerts).toHaveLength(0);
    });
  });

  describe('canary failure (A2)', (it) => {
    it('stays silent before the canary has ever run', () => {
      // Arrange — a canary that has not reported yet must not read as an
      // outage, or every sidecar restart would page someone.
      const metrics = new MetricsRegistry();

      // Act
      const alerts = canaryFailureRule(context(metrics, [], {}, null));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('stays silent when no session was scheduled to probe', () => {
      // Arrange — an idle canary room is not a fault.
      const metrics = new MetricsRegistry();
      const canary = canaryResult({ outcome: CanaryOutcome.NO_SESSION });

      // Act
      const alerts = canaryFailureRule(context(metrics, [], {}, canary));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('fires critical when audio streamed but no captions came back', () => {
      // Arrange — the headline A2 failure.
      const metrics = new MetricsRegistry();
      const canary = canaryResult({
        outcome: CanaryOutcome.NO_TRANSCRIPTS,
        chunksSent: 80,
      });

      // Act
      const alerts = canaryFailureRule(context(metrics, [], {}, canary));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.severity).toBe(AlertSeverity.CRITICAL);
      expect(alerts[0]?.failureModes).toContain('N1');
      expect(alerts[0]?.likelyCause).toContain('captions just stopped');
    });

    it('blames the control plane, not transcription, on an auth failure', () => {
      // Arrange — the stage drives where the operator looks first, so it must
      // track the actual failure rather than always naming the pipeline.
      const metrics = new MetricsRegistry();
      const canary = canaryResult({ outcome: CanaryOutcome.AUTH_FAILED });

      // Act
      const alerts = canaryFailureRule(context(metrics, [], {}, canary));

      // Assert
      expect(alerts[0]?.stage).toBe(PipelineStage.CONTROL_PLANE);
      expect(alerts[0]?.likelyCause).toContain('session-manager');
    });

    it('stays silent on a healthy run', () => {
      // Arrange
      const metrics = new MetricsRegistry();

      // Act
      const alerts = canaryFailureRule(
        context(metrics, [], {}, canaryResult({})),
      );

      // Assert
      expect(alerts).toHaveLength(0);
    });
  });

  describe('canary quality (A2)', (it) => {
    it('does not double-report a failed run as a quality problem', () => {
      // Arrange — a dead pipeline should raise one outage alert, not also an
      // "inaccurate captions" alert about captions that never existed.
      const metrics = new MetricsRegistry();
      const canary = canaryResult({
        outcome: CanaryOutcome.NO_TRANSCRIPTS,
        accuracy: null,
        clockSyncEstablished: false,
      });

      // Act
      const alerts = canaryQualityRule(context(metrics, [], {}, canary));

      // Assert
      expect(alerts).toHaveLength(0);
    });

    it('warns when the first caption takes too long', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      const canary = canaryResult({ timeToFirstTranscriptMs: 30_000 });

      // Act
      const alerts = canaryQualityRule(context(metrics, [], {}, canary));

      // Assert
      const slow = alerts.find((a) => a.id === 'canary-slow-first-transcript');
      expect(slow?.severity).toBe(AlertSeverity.WARNING);
      expect(slow?.failureModes).toContain('T1');
    });

    it('warns when recall falls below the threshold', () => {
      // Arrange
      const metrics = new MetricsRegistry();
      const canary = canaryResult({
        accuracy: {
          recall: 0.1,
          precision: 0.9,
          f1: 0.18,
          missing: ['birch', 'canoe'],
          expectedWordCount: 5,
          actualWordCount: 2,
        },
      });

      // Act
      const alerts = canaryQualityRule(context(metrics, [], {}, canary));

      // Assert
      expect(alerts.some((a) => a.id === 'canary-low-accuracy')).toBe(true);
    });

    it('warns on a looping transcript even when the words are all correct', () => {
      // Arrange — recall and precision stay perfect while the captions are
      // plainly broken, which is why repetition needs its own rule.
      const metrics = new MetricsRegistry();
      const canary = canaryResult({ repetitionRatio: 0.95 });

      // Act
      const alerts = canaryQualityRule(context(metrics, [], {}, canary));

      // Assert
      const repetition = alerts.find((a) => a.id === 'canary-repetition');
      expect(repetition?.likelyCause).toContain('looping');
    });

    it('flags C6 when clock sync never converged', () => {
      // Arrange — pipeline latency still works; only e2e is unavailable, so
      // this is a warning about a blind spot rather than an outage.
      const metrics = new MetricsRegistry();
      const canary = canaryResult({ clockSyncEstablished: false });

      // Act
      const alerts = canaryQualityRule(context(metrics, [], {}, canary));

      // Assert
      const clock = alerts.find((a) => a.id === 'canary-clock-sync');
      expect(clock?.failureModes).toContain('C6');
      expect(clock?.severity).toBe(AlertSeverity.WARNING);
    });

    it('stays silent on a healthy, accurate, timely run', () => {
      // Arrange
      const metrics = new MetricsRegistry();

      // Act
      const alerts = canaryQualityRule(
        context(metrics, [], {}, canaryResult({})),
      );

      // Assert
      expect(alerts).toHaveLength(0);
    });
  });
});
