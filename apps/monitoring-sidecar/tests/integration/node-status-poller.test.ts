import { afterEach, beforeEach, describe, expect } from 'vitest';

import { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';
import { NodeStatusPollerService } from '#src/server/shared/node-status/node-status-poller.service.js';
import {
  FAKE_PROCESS_UID,
  type FakeNodeStatus,
  latencySeries,
  startFakeNodeStatus,
  statusBody,
} from '#tests/fixtures/fake-node-status.js';

const API_KEY = 'test-service-key';
const SERVICE = 'node-server';
const SESSION_A = '22222222-2222-4222-8222-222222222222';
const SESSION_B = '33333333-3333-4333-8333-333333333333';

const logger = {
  warn: () => undefined,
  info: () => undefined,
  error: () => undefined,
} as never;

describe('node-server status poller (B1.1 PR 4)', () => {
  let node: FakeNodeStatus;

  beforeEach(async () => {
    node = await startFakeNodeStatus(API_KEY);
  });

  afterEach(async () => {
    await node.close();
  });

  /**
   * Builds a poller and takes it past its priming poll.
   *
   * The first successful poll of a poller's life only records baselines — the
   * endpoint reports totals since node-server booted, and a sidecar started
   * beside a long-running node would otherwise fold that whole history into one
   * increment stamped `now`, firing every windowed rule on events that predate
   * it. Priming against an all-zero body seeds those baselines at zero, so each
   * test's own first poll differences from zero exactly as it reads.
   */
  async function createPoller(apiKey = API_KEY) {
    const metrics = new MetricsRegistry();
    const poller = new NodeStatusPollerService(
      {
        enabled: apiKey.length > 0,
        intervalMs: 60_000,
        timeoutMs: 2_000,
        service: SERVICE,
        statusUrl: node.statusUrl,
        apiKey: apiKey,
      },
      metrics,
      logger,
    );
    // Only a poll that can succeed primes anything: a wrong key produces a
    // failed poll, and priming with one would leave an error already counted
    // before the test acts.
    if (apiKey === API_KEY) {
      node.setBody(statusBody());
      await poller.pollOnce();
    }
    return { metrics, poller };
  }

  describe('absolute totals become increments', (it) => {
    it('adds only the difference between successive polls', async () => {
      // Arrange - the endpoint reports totals since node-server booted, so
      // setting them verbatim would restate the same events on every poll.
      const { metrics, poller } = await createPoller();
      node.setBody(statusBody({ summary: { decodeDropsTotal: 5 } }));

      // Act
      await poller.pollOnce();
      node.setBody(statusBody({ summary: { decodeDropsTotal: 8 } }));
      await poller.pollOnce();
      await poller.pollOnce();

      // Assert - 8 total events seen, not 5 + 8 + 8
      expect(
        metrics.safpDecodeDropsTotal.get({ service: SERVICE, side: 'node' }),
      ).toBe(8);
    });

    it('keeps the rolling window meaningful for the alert rules', async () => {
      // Arrange
      const { metrics, poller } = await createPoller();

      // Act
      node.setBody(statusBody({ summary: { upstreamChurnTotal: 4 } }));
      await poller.pollOnce();

      // Assert - the window sees 4 increments, which is what the N1 rule counts
      expect(
        metrics.upstreamChurnTotal.windowCount({ service: SERVICE }, 120_000),
      ).toBe(4);
    });

    it('expands labelled arrays into one series per label set', async () => {
      // Arrange
      const { metrics, poller } = await createPoller();
      node.setBody(
        statusBody({
          wsCloses: [
            {
              code: 1008,
              reason: 'invalid-token',
              role: 'source',
              initiator: 'server',
              count: 3,
            },
            {
              code: 1006,
              reason: 'other',
              role: 'client',
              initiator: 'peer',
              count: 1,
            },
          ],
          authFailures: [{ reason: 'invalid-token', count: 3 }],
          upstreamStateTransitions: [
            { from: 'OPEN', to: 'WAITING_RETRY', count: 2 },
          ],
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      expect(
        metrics.wsCloseTotal.get({
          service: SERVICE,
          code: '1008',
          reason: 'invalid-token',
          role: 'source',
          initiator: 'server',
        }),
      ).toBe(3);
      expect(
        metrics.wsCloseTotal.get({
          service: SERVICE,
          code: '1006',
          reason: 'other',
          role: 'client',
          initiator: 'peer',
        }),
      ).toBe(1);
      expect(
        metrics.nodeAuthFailuresTotal.get({
          service: SERVICE,
          reason: 'invalid-token',
        }),
      ).toBe(3);
      expect(
        metrics.upstreamStateTotal.get({
          service: SERVICE,
          from: 'OPEN',
          to: 'WAITING_RETRY',
        }),
      ).toBe(2);
    });
  });

  describe('restart handling', (it) => {
    it('rebases instead of differencing when processUid changes', async () => {
      // Arrange - a restarted node-server reports every counter back at zero.
      // Differencing against the dead process would produce a large negative.
      const { metrics, poller } = await createPoller();
      node.setBody(statusBody({ summary: { authTimeoutsTotal: 100 } }));
      await poller.pollOnce();

      // Act
      node.setBody(
        statusBody({
          processUid: '99999999-9999-4999-8999-999999999999',
          summary: { authTimeoutsTotal: 2 },
        }),
      );
      const result = await poller.pollOnce();

      // Assert - the 2 events of the new process are added, nothing is lost or
      // subtracted, and the restart itself is observable.
      expect(result.restarted).toBe(true);
      expect(metrics.nodeAuthTimeoutsTotal.get({ service: SERVICE })).toBe(102);
      expect(
        metrics.serviceProcessRestartsTotal.get({ service: SERVICE }),
      ).toBe(1);
    });

    it('treats a counter that went backwards as a missed restart', async () => {
      // Arrange - a restart between two polls that we happened not to observe
      // as a uid change would otherwise decrement.
      const { metrics, poller } = await createPoller();
      node.setBody(statusBody({ summary: { latencySamplesTotal: 50 } }));
      await poller.pollOnce();

      // Act - same uid, smaller total
      node.setBody(statusBody({ summary: { latencySamplesTotal: 3 } }));
      await poller.pollOnce();

      // Assert
      expect(metrics.nodeLatencySamplesTotal.get({ service: SERVICE })).toBe(
        53,
      );
    });

    it('does not report a restart on the very first poll', async () => {
      // Arrange
      const { metrics, poller } = await createPoller();

      // Act
      const result = await poller.pollOnce();

      // Assert - there is no previous process to have restarted from
      expect(result.restarted).toBe(false);
      expect(result.processUid).toBe(FAKE_PROCESS_UID);
      expect(metrics.serviceProcessRestartsTotal.total()).toBe(0);
    });
  });

  describe('session gauges', (it) => {
    it('reports per-session sources, subscribers and upstream state', async () => {
      // Arrange
      const { metrics, poller } = await createPoller();
      node.setBody(
        statusBody({
          summary: { activeSessionCount: 2 },
          sessions: [
            {
              sessionUid: SESSION_A,
              sourceCount: 1,
              subscriberCount: 3,
              pendingChunkCount: 12,
              upstreamState: 'OPEN',
              upstreamRetryAttempt: 0,
            },
            {
              sessionUid: SESSION_B,
              sourceCount: 1,
              subscriberCount: 1,
              pendingChunkCount: 2000,
              upstreamState: 'WAITING_RETRY',
              upstreamRetryAttempt: 4,
            },
          ],
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      expect(metrics.nodeActiveSessions.get({ service: SERVICE })).toBe(2);
      expect(
        metrics.nodeSessionSubscribers.get({
          service: SERVICE,
          sessionUid: SESSION_A,
        }),
      ).toBe(3);
      expect(
        metrics.nodeSessionUpstreamUp.get({
          service: SERVICE,
          sessionUid: SESSION_A,
        }),
      ).toBe(1);
      expect(
        metrics.nodeSessionUpstreamUp.get({
          service: SERVICE,
          sessionUid: SESSION_B,
        }),
      ).toBe(0);
      expect(
        metrics.nodeSessionUpstreamRetryAttempt.get({
          service: SERVICE,
          sessionUid: SESSION_B,
        }),
      ).toBe(4);
      expect(
        metrics.nodeSessionPendingChunks.get({
          service: SERVICE,
          sessionUid: SESSION_B,
        }),
      ).toBe(2000);
    });

    it('forgets a session once it ends', async () => {
      // Arrange - a gauge left behind would claim a room is still connected
      // long after everyone went home.
      const { metrics, poller } = await createPoller();
      node.setBody(
        statusBody({
          summary: { activeSessionCount: 1 },
          sessions: [
            {
              sessionUid: SESSION_A,
              sourceCount: 1,
              subscriberCount: 2,
              pendingChunkCount: 0,
              upstreamState: 'OPEN',
              upstreamRetryAttempt: 0,
            },
          ],
        }),
      );
      await poller.pollOnce();

      // Act
      node.setBody(statusBody());
      await poller.pollOnce();

      // Assert
      expect(
        metrics.nodeSessionSubscribers.get({
          service: SERVICE,
          sessionUid: SESSION_A,
        }),
      ).toBeUndefined();
      expect(metrics.nodeActiveSessions.get({ service: SERVICE })).toBe(0);
    });

    it('keeps known sessions when the response was truncated', async () => {
      // Arrange - absence from a truncated list means "not told about", not
      // "ended". Deleting on truncation would blank the dashboard exactly when
      // the deployment is busiest.
      const { metrics, poller } = await createPoller();
      node.setBody(
        statusBody({
          summary: { activeSessionCount: 1 },
          sessions: [
            {
              sessionUid: SESSION_A,
              sourceCount: 1,
              subscriberCount: 2,
              pendingChunkCount: 0,
              upstreamState: 'OPEN',
              upstreamRetryAttempt: 0,
            },
          ],
        }),
      );
      await poller.pollOnce();

      // Act
      node.setBody(
        statusBody({
          summary: { activeSessionCount: 400 },
          sessions: [
            {
              sessionUid: SESSION_B,
              sourceCount: 1,
              subscriberCount: 1,
              pendingChunkCount: 0,
              upstreamState: 'OPEN',
              upstreamRetryAttempt: 0,
            },
          ],
          sessionsTruncated: true,
        }),
      );
      await poller.pollOnce();

      // Assert
      expect(
        metrics.nodeSessionSubscribers.get({
          service: SERVICE,
          sessionUid: SESSION_A,
        }),
      ).toBe(2);
    });
  });

  describe('latency quantiles', (it) => {
    it('mirrors each measure and kind onto its own gauge series', async () => {
      // Arrange - node-server reports pre-computed percentiles, so these become
      // quantile-labelled gauges rather than local histogram observations.
      const { metrics, poller } = await createPoller();
      node.setBody(
        statusBody({
          latency: [
            latencySeries({ measure: 'pipeline', kind: 'final', p95: 300 }),
            latencySeries({
              measure: 'pipeline',
              kind: 'inProgress',
              p95: 40,
            }),
            latencySeries({ measure: 'e2e', kind: 'final', p95: 900 }),
          ],
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert - interim and final stay separate; pooled they would describe
      // neither population.
      expect(
        metrics.nodePipelineLatencyMs.get({
          service: SERVICE,
          kind: 'final',
          quantile: 'p95',
        }),
      ).toBe(300);
      expect(
        metrics.nodePipelineLatencyMs.get({
          service: SERVICE,
          kind: 'inProgress',
          quantile: 'p95',
        }),
      ).toBe(40);
      expect(
        metrics.nodeE2eLatencyMs.get({
          service: SERVICE,
          kind: 'final',
          quantile: 'p95',
        }),
      ).toBe(900);
      // Never reported, so never exported - not exported as zero.
      expect(
        metrics.nodeE2eLatencyMs.get({
          service: SERVICE,
          kind: 'inProgress',
          quantile: 'p95',
        }),
      ).toBeUndefined();
    });

    it('ignores a series with nothing retained', async () => {
      // Arrange - an empty ring carries meaningless zeroes, and a p95 of 0 on a
      // latency panel reads as "instant" rather than "no data".
      const { metrics, poller } = await createPoller();
      node.setBody(
        statusBody({
          latency: [latencySeries({ sampleCount: 0, p95: 0, p50: 0, p99: 0 })],
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      expect(
        metrics.nodePipelineLatencyMs.get({
          service: SERVICE,
          kind: 'final',
          quantile: 'p95',
        }),
      ).toBeUndefined();
    });

    it('forgets a series that stopped being reported', async () => {
      // Arrange - a stale p95 left behind would keep a latency alert firing
      // long after the traffic that caused it stopped.
      const { metrics, poller } = await createPoller();
      node.setBody(statusBody({ latency: [latencySeries({ p95: 300 })] }));
      await poller.pollOnce();

      // Act
      node.setBody(statusBody({ latency: [] }));
      await poller.pollOnce();

      // Assert
      expect(
        metrics.nodePipelineLatencyMs.get({
          service: SERVICE,
          kind: 'final',
          quantile: 'p95',
        }),
      ).toBeUndefined();
    });
  });

  describe('failure handling', (it) => {
    it('reports unauthorized separately from unreachable', async () => {
      // Arrange - a wrong service key is a config error, not an outage, and the
      // operator's next action is different.
      const { metrics, poller } = await createPoller('wrong-key');

      // Act
      const result = await poller.pollOnce();

      // Assert
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('unauthorized');
      expect(
        metrics.serviceStatusPollErrorsTotal.get({
          service: SERVICE,
          reason: 'unauthorized',
        }),
      ).toBe(1);
      expect(metrics.serviceStatusUp.get({ service: SERVICE })).toBe(0);
    });

    it('rejects a body that does not match the status schema', async () => {
      // Arrange - a node-server on a different contract must fail loudly
      // rather than half-populate metrics.
      const { metrics, poller } = await createPoller();
      node.setMalformed(true);

      // Act
      const result = await poller.pollOnce();

      // Assert
      expect(result.reason).toBe('malformed');
      expect(metrics.serviceStatusUp.get({ service: SERVICE })).toBe(0);
    });

    it('reports a server error without losing prior counter values', async () => {
      // Arrange
      const { metrics, poller } = await createPoller();
      node.setBody(statusBody({ summary: { decodeDropsTotal: 7 } }));
      await poller.pollOnce();

      // Act
      node.setFailure(500);
      const result = await poller.pollOnce();

      // Assert - counters hold their last known value; `up` says they are stale
      expect(result.reason).toBe('http-error');
      expect(
        metrics.safpDecodeDropsTotal.get({ service: SERVICE, side: 'node' }),
      ).toBe(7);
      expect(metrics.serviceStatusUp.get({ service: SERVICE })).toBe(0);
    });

    it('recovers and marks the poll up again', async () => {
      // Arrange
      const { metrics, poller } = await createPoller();
      node.setFailure(500);
      await poller.pollOnce();

      // Act
      node.setFailure(null);
      const result = await poller.pollOnce();

      // Assert
      expect(result.ok).toBe(true);
      expect(metrics.serviceStatusUp.get({ service: SERVICE })).toBe(1);
    });

    it('presents the service API key as a bearer credential', async () => {
      // Arrange
      const { poller } = await createPoller();

      // Act
      await poller.pollOnce();

      // Assert
      expect(node.authHeaders.at(-1)).toBe(`Bearer ${API_KEY}`);
    });
  });

  describe('secret placeholders (PLAN-ConfigCheck-Coverage Phase 2)', (it) => {
    it('is null before any successful poll', async () => {
      // Arrange - an unauthorized poll never reaches `_apply`, so there is
      // nothing to classify yet.
      const { poller } = await createPoller('wrong-key');

      // Act
      await poller.pollOnce();

      // Assert
      expect(poller.secretPlaceholders).toBeNull();
    });

    it('relays the classification node-server reports, unmodified', async () => {
      // Arrange - the poller must not recompute this from anything of its
      // own; node-server is the only side that ever sees the real secrets.
      const { poller } = await createPoller();
      node.setBody(
        statusBody({
          secretPlaceholders: {
            transcriptionServiceApiKeyIsPlaceholder: true,
          },
        }),
      );

      // Act
      await poller.pollOnce();

      // Assert
      expect(poller.secretPlaceholders).toStrictEqual({
        sessionTokenSigningKeyIsPlaceholder: false,
        sessionManagerServiceApiKeyIsPlaceholder: false,
        nodeServerServiceApiKeyIsPlaceholder: false,
        transcriptionServiceApiKeyIsPlaceholder: true,
      });
    });

    it('keeps the last known classification when a later poll fails', async () => {
      // Arrange - a gauge left behind is the existing convention for a
      // transient outage (see "reports a server error without losing prior
      // counter values" above); the endpoint controller, not the poller, is
      // what decides whether to still call this current.
      const { poller } = await createPoller();
      node.setBody(
        statusBody({
          secretPlaceholders: { nodeServerServiceApiKeyIsPlaceholder: true },
        }),
      );
      await poller.pollOnce();

      // Act
      node.setFailure(500);
      await poller.pollOnce();

      // Assert
      expect(
        poller.secretPlaceholders?.nodeServerServiceApiKeyIsPlaceholder,
      ).toBe(true);
    });
  });

  describe('enabled', (it) => {
    it('is true when constructed with an API key', async () => {
      // Act
      const { poller } = await createPoller();

      // Assert
      expect(poller.enabled).toBe(true);
    });

    it('is false when constructed with no API key', async () => {
      // Act
      const { poller } = await createPoller('');

      // Assert
      expect(poller.enabled).toBe(false);
    });
  });

  describe('disabled', (it) => {
    it('never polls when no service API key is configured', async () => {
      // Arrange - failing closed keeps a default deployment from 401-ing
      // node-server on every interval forever. A disabled poller is not primed
      // either; there is nothing to prime against.
      const { poller } = await createPoller('');

      // Act
      poller.start();

      // Assert
      expect(node.authHeaders).toHaveLength(0);
      expect(poller.lastResult).toBeNull();
      poller.stop();
    });
  });
});
