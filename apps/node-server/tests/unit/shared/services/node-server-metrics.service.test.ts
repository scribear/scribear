import { describe, expect } from 'vitest';

import { NodeServerMetricsService } from '#src/server/shared/services/node-server-metrics.service.js';

const SESSION_UID = '00000000-0000-0000-0000-000000000001';
const OTHER_SESSION_UID = '00000000-0000-0000-0000-000000000002';

describe('NodeServerMetricsService process identity', (it) => {
  it('gives each instance a distinct uid so consumers can detect a restart', () => {
    // Arrange / Act - a fresh instance stands in for a fresh process.
    const first = new NodeServerMetricsService();
    const second = new NodeServerMetricsService();

    // Assert - without this, a restart's counter reset reads as a large
    // negative rate rather than as a restart.
    expect(first.processUid).not.toBe(second.processUid);
    expect(() => new Date(first.processStartedAt).toISOString()).not.toThrow();
  });

  it('starts every counter at zero', () => {
    // Arrange / Act
    const snapshot = new NodeServerMetricsService().snapshot();

    // Assert
    expect(snapshot.decodeDropsTotal).toBe(0);
    expect(snapshot.authSuccessTotal).toBe(0);
    expect(snapshot.upstreamChurnTotal).toBe(0);
    expect(snapshot.wsCloses).toEqual([]);
    expect(snapshot.authFailures).toEqual([]);
    expect(snapshot.upstreamStateTransitions).toEqual([]);
  });
});

describe('NodeServerMetricsService subscriber tracking', (it) => {
  it('counts connections per session and forgets a session once empty', () => {
    // Arrange
    const metrics = new NodeServerMetricsService();

    // Act
    metrics.recordConnectionOpen(SESSION_UID);
    metrics.recordConnectionOpen(SESSION_UID);
    metrics.recordConnectionOpen(OTHER_SESSION_UID);

    // Assert - per-session, not global.
    expect(metrics.subscriberCount(SESSION_UID)).toBe(2);
    expect(metrics.subscriberCount(OTHER_SESSION_UID)).toBe(1);

    // Act - drain one session.
    metrics.recordConnectionClose(SESSION_UID);
    metrics.recordConnectionClose(SESSION_UID);

    // Assert - the entry is dropped, so the map tracks live sessions rather
    // than growing for the life of the process.
    expect(metrics.subscriberCount(SESSION_UID)).toBe(0);
    expect(metrics.subscriberCount(OTHER_SESSION_UID)).toBe(1);
  });

  it('never goes negative when a close arrives without a matching open', () => {
    // Arrange
    const metrics = new NodeServerMetricsService();

    // Act - a close for a session that was never opened.
    metrics.recordConnectionClose(SESSION_UID);

    // Assert
    expect(metrics.subscriberCount(SESSION_UID)).toBe(0);
  });
});

describe('NodeServerMetricsService upstream churn', (it) => {
  it('tallies each transition and counts only retries as churn', () => {
    // Arrange - a healthy connect, then a flap and recovery.
    const metrics = new NodeServerMetricsService();

    // Act
    metrics.recordUpstreamStateChange('IDLE', 'CONNECTING');
    metrics.recordUpstreamStateChange('CONNECTING', 'HANDSHAKING');
    metrics.recordUpstreamStateChange('HANDSHAKING', 'OPEN');
    metrics.recordUpstreamStateChange('OPEN', 'WAITING_RETRY');
    metrics.recordUpstreamStateChange('WAITING_RETRY', 'CONNECTING');
    metrics.recordUpstreamStateChange('CONNECTING', 'WAITING_RETRY');

    // Assert - churn counts entries into WAITING_RETRY only; a normal
    // connect sequence must contribute zero, or N1 fires on every session.
    const snapshot = metrics.snapshot();
    expect(snapshot.upstreamChurnTotal).toBe(2);
    expect(snapshot.upstreamStateTransitions).toContainEqual({
      from: 'CONNECTING',
      to: 'HANDSHAKING',
      count: 1,
    });
    expect(snapshot.upstreamStateTransitions).toContainEqual({
      from: 'OPEN',
      to: 'WAITING_RETRY',
      count: 1,
    });
  });
});

describe('NodeServerMetricsService close tallies', (it) => {
  it('separates server- and peer-initiated closes with the same code', () => {
    // Arrange
    const metrics = new NodeServerMetricsService();

    // Act
    metrics.recordWsClose(1008, 'invalid-token', 'source', 'server');
    metrics.recordWsClose(1008, 'invalid-token', 'source', 'server');
    metrics.recordWsClose(1000, 'session-ended', 'client', 'peer');

    // Assert - a flapping client uplink must not be indistinguishable from
    // an auth rejection.
    const { wsCloses } = metrics.snapshot();
    expect(wsCloses).toContainEqual({
      code: 1008,
      reason: 'invalid-token',
      role: 'source',
      initiator: 'server',
      count: 2,
    });
    expect(wsCloses).toContainEqual({
      code: 1000,
      reason: 'session-ended',
      role: 'client',
      initiator: 'peer',
      count: 1,
    });
  });

  it('collapses unrecognised peer reasons so a client cannot grow the label map', () => {
    // Arrange - a peer supplies arbitrary close-reason text.
    const metrics = new NodeServerMetricsService();

    // Act
    metrics.recordWsClose(1006, 'going away, brb', 'client', 'peer');
    metrics.recordWsClose(1006, 'totally different text', 'client', 'peer');

    // Assert - both land in one `other` bucket rather than two labels.
    const { wsCloses } = metrics.snapshot();
    expect(wsCloses).toHaveLength(1);
    expect(wsCloses[0]).toEqual({
      code: 1006,
      reason: 'other',
      role: 'client',
      initiator: 'peer',
      count: 2,
    });
  });
});

describe('NodeServerMetricsService auth outcomes', (it) => {
  it('records failures by reason alongside the success denominator', () => {
    // Arrange - S2 (signing-key drift) is a ratio approaching 1.0, not a
    // count, so the success side has to be recorded too.
    const metrics = new NodeServerMetricsService();

    // Act
    metrics.recordAuthFailure('invalid-token');
    metrics.recordAuthFailure('invalid-token');
    metrics.recordAuthFailure('token-expired');
    metrics.recordAuthSuccess();
    metrics.recordAuthTimeout();

    // Assert
    const snapshot = metrics.snapshot();
    expect(snapshot.authFailures).toContainEqual({
      reason: 'invalid-token',
      count: 2,
    });
    expect(snapshot.authFailures).toContainEqual({
      reason: 'token-expired',
      count: 1,
    });
    expect(snapshot.authSuccessTotal).toBe(1);
    expect(snapshot.authTimeoutsTotal).toBe(1);
  });
});

describe('NodeServerMetricsService latency outcomes', (it) => {
  it('splits end-to-end outcomes and keeps the sample denominator', () => {
    // Arrange
    const metrics = new NodeServerMetricsService();

    // Act
    metrics.recordLatencySample('ok');
    metrics.recordLatencySample('ok');
    metrics.recordLatencySample('unavailable');
    metrics.recordLatencySample('negative');
    metrics.recordLatencyUnmatchedChunk();

    // Assert - S5 is negative/total, which needs both numbers.
    const snapshot = metrics.snapshot();
    expect(snapshot.latencySamplesTotal).toBe(4);
    expect(snapshot.latencyE2eUnavailableTotal).toBe(1);
    expect(snapshot.latencyE2eNegativeTotal).toBe(1);
    expect(snapshot.latencyUnmatchedChunkTotal).toBe(1);
  });
});

describe('NodeServerMetricsService snapshot isolation', (it) => {
  it('does not let a returned snapshot mutate with later activity', () => {
    // Arrange
    const metrics = new NodeServerMetricsService();
    metrics.recordDecodeDrop();
    metrics.recordWsClose(1007, 'invalid-json', 'source', 'server');

    // Act
    const taken = metrics.snapshot();
    metrics.recordDecodeDrop();
    metrics.recordWsClose(1007, 'invalid-json', 'source', 'server');

    // Assert - the sidecar differences successive reads, so a snapshot that
    // kept mutating would silently zero out the delta.
    expect(taken.decodeDropsTotal).toBe(1);
    expect(taken.wsCloses[0]?.count).toBe(1);
    expect(metrics.snapshot().decodeDropsTotal).toBe(2);
  });
});
