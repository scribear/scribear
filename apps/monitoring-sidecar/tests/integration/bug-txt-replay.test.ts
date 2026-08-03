import { afterEach, beforeEach, describe, expect } from 'vitest';

import { AlertEvaluatorService } from '#src/server/shared/alerts/alert-evaluator.service.js';
import { DEFAULT_THRESHOLDS } from '#src/server/shared/alerts/alert-rules.js';
import type { CanaryRunnerService } from '#src/server/shared/canary/canary-runner.service.js';
import { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';
import { buildSnapshot } from '#src/server/shared/metrics/snapshot-builder.js';
import { NodeStatusPollerService } from '#src/server/shared/node-status/node-status-poller.service.js';
import type {
  ProbePollerService,
  ProbeStatus,
} from '#src/server/shared/probes/probe-poller.service.js';
import type { TranscriptionMetricsPollerService } from '#src/server/shared/transcription-metrics/transcription-metrics-poller.service.js';
import {
  type FakeNodeStatus,
  type FakeSession,
  type FakeSessionInput,
  startFakeNodeStatus,
  statusBody,
} from '#tests/fixtures/fake-node-status.js';

const API_KEY = 'test-service-key';
const SESSION_BAD = '44444444-4444-4444-8444-444444444444';
const SESSION_GOOD = '55555555-5555-4555-8555-555555555555';

const logger = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
} as never;

function session(overrides: Partial<FakeSession> = {}): FakeSessionInput {
  return {
    sessionUid: SESSION_BAD,
    sourceCount: 1,
    subscriberCount: 1,
    pendingChunkCount: 0,
    upstreamState: 'OPEN',
    upstreamRetryAttempt: 0,
    ...overrides,
  };
}

/**
 * Replays the BUG.txt failure: node-server's upstream link to
 * transcription-service repeatedly drops and reconnects while the session still
 * reports as running.
 *
 * Since B1.1 this is driven through the status endpoint rather than log text.
 * That is the point of the cut-over — the endpoint counts churn in-process, so
 * detection no longer depends on the sidecar having been attached to the log
 * stream for the whole window, on the log level, or on nothing having rotated
 * out.
 */
describe('BUG.txt upstream flap replay', () => {
  let node: FakeNodeStatus;

  beforeEach(async () => {
    node = await startFakeNodeStatus(API_KEY);
  });

  afterEach(async () => {
    await node.close();
  });

  /**
   * Builds the poller/evaluator pair and takes it past its priming poll, which
   * records baselines without emitting increments — see `_advance`. Without it a
   * replay's first body would be folded as node-server's whole lifetime.
   */
  async function createStack(probes: ProbeStatus[] = []) {
    const metrics = new MetricsRegistry();
    const poller = new NodeStatusPollerService(
      {
        enabled: true,
        intervalMs: 60_000,
        timeoutMs: 2_000,
        service: 'node-server',
        statusUrl: node.statusUrl,
        apiKey: API_KEY,
      },
      metrics,
      logger,
    );
    const probePoller = { statuses: () => probes } as ProbePollerService;
    // The canary is irrelevant to this replay; a runner that has never produced
    // a result keeps the canary rules inert without stubbing the whole service.
    const canaryRunner = { lastResult: null } as CanaryRunnerService;
    const transcriptionPoller = {
      providerDevices: new Map<string, string>(),
    } as unknown as TranscriptionMetricsPollerService;
    const evaluator = new AlertEvaluatorService(
      metrics,
      probePoller,
      canaryRunner,
      DEFAULT_THRESHOLDS,
      transcriptionPoller,
    );
    node.setBody(statusBody());
    await poller.pollOnce();
    return { metrics, poller, evaluator };
  }

  describe('N1 detection from the status endpoint', (it) => {
    it('raises a critical N1 alert once the flap crosses the threshold', async () => {
      // Arrange - a healthy first poll, so the alert cannot come from a
      // cold-start baseline being mistaken for a burst of churn.
      const { poller, evaluator } = await createStack();
      node.setBody(statusBody({ sessions: [session()] }));
      await poller.pollOnce();

      // Act - four reconnects since, and the session is now retrying
      node.setBody(
        statusBody({
          summary: { upstreamChurnTotal: 4, activeSessionCount: 1 },
          sessions: [
            session({
              upstreamState: 'WAITING_RETRY',
              upstreamRetryAttempt: 2,
            }),
          ],
        }),
      );
      await poller.pollOnce();
      const alerts = evaluator.evaluate(Date.now());

      // Assert
      const n1 = alerts.find((a) => a.failureModes.includes('N1'));
      expect(n1).toBeDefined();
      expect(n1?.severity).toBe('critical');
      expect(n1?.value).toBe(4);
    });

    it('stays silent for a healthy session', async () => {
      // Arrange - the do-no-false-alarm side of the gate. A session that starts
      // up normally walks IDLE -> CONNECTING -> HANDSHAKING -> OPEN, and none of
      // that is churn.
      const { poller, evaluator } = await createStack();

      // Act
      node.setBody(
        statusBody({
          summary: { activeSessionCount: 1 },
          upstreamStateTransitions: [
            { from: 'IDLE', to: 'CONNECTING', count: 1 },
            { from: 'CONNECTING', to: 'HANDSHAKING', count: 1 },
            { from: 'HANDSHAKING', to: 'OPEN', count: 1 },
          ],
          sessions: [session()],
        }),
      );
      await poller.pollOnce();
      const alerts = evaluator.evaluate(Date.now());

      // Assert
      expect(alerts.filter((a) => a.failureModes.includes('N1'))).toHaveLength(
        0,
      );
    });

    it('names the flapping session and not the healthy one', async () => {
      // Arrange - a real deployment runs many rooms at once. The counter is now
      // process-wide, so the room is named from the per-session upstream gauge.
      const { poller, evaluator } = await createStack();

      // Act
      node.setBody(
        statusBody({
          summary: { upstreamChurnTotal: 4, activeSessionCount: 2 },
          sessions: [
            session({
              upstreamState: 'WAITING_RETRY',
              upstreamRetryAttempt: 3,
            }),
            session({ sessionUid: SESSION_GOOD }),
          ],
        }),
      );
      await poller.pollOnce();
      const alerts = evaluator
        .evaluate(Date.now())
        .filter((a) => a.failureModes.includes('N1'));

      // Assert
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.summary).toContain(SESSION_BAD);
      expect(alerts[0]?.summary).not.toContain(SESSION_GOOD);
    });
  });

  // The 'correlated N2 root cause' case was removed in B1.2 PR 5b along with
  // log ingest. It asserted that a session-config-stream 401 (from
  // session-manager's logs) surfaced alongside the N1 churn it causes, so the
  // alert named the cause and not just the symptom. Nothing detects that 401
  // now; the churn half of the story is still covered above. Restoring it needs
  // a session-manager status endpoint.

  describe('snapshot output', (it) => {
    it('exposes the firing alert, the churn counter and the session gauges', async () => {
      // Arrange
      const { metrics, poller, evaluator } = await createStack();
      node.setBody(
        statusBody({
          summary: { upstreamChurnTotal: 4, activeSessionCount: 1 },
          sessions: [
            session({
              upstreamState: 'WAITING_RETRY',
              upstreamRetryAttempt: 2,
            }),
          ],
        }),
      );
      await poller.pollOnce();
      const at = Date.now();

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

      // The gauges are what let the SPA draw the affected room rather than just
      // a number: which session, in what upstream state, how many retries.
      const upstreamUp = snapshot.gauges['scribear_node_session_upstream_up'];
      expect(upstreamUp).toStrictEqual([
        {
          labels: { service: 'node-server', sessionUid: SESSION_BAD },
          value: 0,
        },
      ]);
      expect(snapshot.gauges['scribear_service_status_up']?.[0]?.value).toBe(1);
    });
  });
});
