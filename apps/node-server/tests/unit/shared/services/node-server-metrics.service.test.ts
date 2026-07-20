import { describe, expect } from 'vitest';

import {
  type LatencyMeasure,
  type LatencySample,
  type LatencySampleKind,
  type LatencySeries,
  NodeServerMetricsService,
} from '#src/server/shared/services/node-server-metrics.service.js';

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

/** A latency sample with sensible defaults, so each test states only its point. */
function latencySample(overrides: Partial<LatencySample> = {}): LatencySample {
  return {
    sessionUid: SESSION_UID,
    kind: 'final',
    pipelineMs: 100,
    e2eMs: 200,
    e2eOutcome: 'ok',
    ...overrides,
  };
}

/** The one series matching `measure`/`kind`, or undefined when absent. */
function seriesOf(
  series: LatencySeries[],
  measure: LatencyMeasure,
  kind: LatencySampleKind,
): LatencySeries | undefined {
  return series.find((s) => s.measure === measure && s.kind === kind);
}

describe('NodeServerMetricsService latency outcomes', (it) => {
  it('splits end-to-end outcomes and keeps the sample denominator', () => {
    // Arrange
    const metrics = new NodeServerMetricsService();

    // Act
    metrics.recordLatencySample(latencySample());
    metrics.recordLatencySample(latencySample());
    metrics.recordLatencySample(
      latencySample({ e2eMs: null, e2eOutcome: 'unavailable' }),
    );
    metrics.recordLatencySample(
      latencySample({ e2eMs: null, e2eOutcome: 'negative' }),
    );
    metrics.recordLatencyUnmatchedChunk();

    // Assert - S5 is negative/total, which needs both numbers.
    const snapshot = metrics.snapshot();
    expect(snapshot.latencySamplesTotal).toBe(4);
    expect(snapshot.latencyE2eUnavailableTotal).toBe(1);
    expect(snapshot.latencyE2eNegativeTotal).toBe(1);
    expect(snapshot.latencyUnmatchedChunkTotal).toBe(1);
  });
});

describe('NodeServerMetricsService latency percentiles', (it) => {
  it('reports nearest-rank percentiles over the observed samples', () => {
    // Arrange - 1..100ms, shuffled by stepping a coprime stride, so the result
    // cannot come from the arrival order.
    const metrics = new NodeServerMetricsService();

    // Act
    for (let i = 1; i <= 100; i++) {
      const value = ((i * 37) % 100) + 1;
      metrics.recordLatencySample(
        latencySample({ pipelineMs: value, e2eMs: value * 2 }),
      );
    }

    // Assert - nearest rank over 100 sorted samples: p50 is the 50th, p95 the
    // 95th, p99 the 99th.
    const pipeline = seriesOf(metrics.snapshot().latency, 'pipeline', 'final');
    expect(pipeline).toMatchObject({
      count: 100,
      sampleCount: 100,
      sum: 5050,
      min: 1,
      max: 100,
      mean: 50.5,
      p50: 50,
      p95: 95,
      p99: 99,
    });

    // Assert - the end-to-end leg is a separate series, not the same numbers.
    expect(seriesOf(metrics.snapshot().latency, 'e2e', 'final')?.p50).toBe(100);
  });

  it('keeps interim and final transcripts as separate populations', () => {
    // Arrange - finals are routinely far slower than interims; pooled, the
    // percentiles would describe neither.
    const metrics = new NodeServerMetricsService();

    // Act
    for (let i = 0; i < 10; i++) {
      metrics.recordLatencySample(
        latencySample({ kind: 'inProgress', pipelineMs: 10, e2eMs: 20 }),
      );
      metrics.recordLatencySample(
        latencySample({ kind: 'final', pipelineMs: 500, e2eMs: 900 }),
      );
    }

    // Assert
    const series = metrics.snapshot().latency;
    expect(seriesOf(series, 'pipeline', 'inProgress')?.p95).toBe(10);
    expect(seriesOf(series, 'pipeline', 'final')?.p95).toBe(500);
    expect(series).toHaveLength(4);
  });

  it('omits an end-to-end series when no sample ever carried one', () => {
    // Arrange - a source that sends no timestamp. Recording those as zero
    // would report the fastest room in the fleet.
    const metrics = new NodeServerMetricsService();

    // Act
    metrics.recordLatencySample(
      latencySample({ e2eMs: null, e2eOutcome: 'unavailable' }),
    );

    // Assert
    const series = metrics.snapshot().latency;
    expect(seriesOf(series, 'pipeline', 'final')?.sampleCount).toBe(1);
    expect(seriesOf(series, 'e2e', 'final')).toBeUndefined();
  });

  it('retains only the most recent samples once the window is full', () => {
    // Arrange - the per-session window is 512 deep, so the early samples must
    // age out rather than being averaged in forever.
    const metrics = new NodeServerMetricsService();
    metrics.recordConnectionOpen(SESSION_UID);

    // Act - 512 slow samples, then 512 fast ones.
    for (let i = 0; i < 512; i++) {
      metrics.recordLatencySample(latencySample({ pipelineMs: 1000 }));
    }
    for (let i = 0; i < 512; i++) {
      metrics.recordLatencySample(latencySample({ pipelineMs: 10 }));
    }

    // Assert - the window describes recent behaviour; `count`/`sum` remain
    // lifetime totals, which is why they disagree with `mean`.
    const series = seriesOf(
      metrics.sessionLatency(SESSION_UID),
      'pipeline',
      'final',
    );
    expect(series).toMatchObject({
      count: 1024,
      sampleCount: 512,
      min: 10,
      max: 10,
      p99: 10,
    });
    expect(series?.sum).toBe(512 * 1000 + 512 * 10);
  });
});

describe('NodeServerMetricsService per-session latency', (it) => {
  it('attributes samples to their own session', () => {
    // Arrange
    const metrics = new NodeServerMetricsService();
    metrics.recordConnectionOpen(SESSION_UID);
    metrics.recordConnectionOpen(OTHER_SESSION_UID);

    // Act
    metrics.recordLatencySample(latencySample({ pipelineMs: 10 }));
    metrics.recordLatencySample(
      latencySample({ sessionUid: OTHER_SESSION_UID, pipelineMs: 900 }),
    );

    // Assert - one slow room must not drag the other's numbers.
    expect(
      seriesOf(metrics.sessionLatency(SESSION_UID), 'pipeline', 'final')?.p50,
    ).toBe(10);
    expect(
      seriesOf(metrics.sessionLatency(OTHER_SESSION_UID), 'pipeline', 'final')
        ?.p50,
    ).toBe(900);

    // Assert - and both still land in the process-wide window.
    expect(
      seriesOf(metrics.snapshot().latency, 'pipeline', 'final')?.sampleCount,
    ).toBe(2);
  });

  it('discards a session’s window when its last connection closes', () => {
    // Arrange
    const metrics = new NodeServerMetricsService();
    metrics.recordConnectionOpen(SESSION_UID);
    metrics.recordLatencySample(latencySample());

    // Act
    metrics.recordConnectionClose(SESSION_UID);

    // Assert - per-session latency is a live gauge with the same lifetime as
    // `subscriberCount`, so it must not outlive the room.
    expect(metrics.sessionLatency(SESSION_UID)).toEqual([]);
    // Assert - but the process-wide history is monotonic and survives.
    expect(
      seriesOf(metrics.snapshot().latency, 'pipeline', 'final')?.count,
    ).toBe(1);
  });

  it('still counts a sample for a session with no recorded connection', () => {
    // Arrange - nothing opened a connection for this session, so there is no
    // entry to attribute to.
    const metrics = new NodeServerMetricsService();

    // Act
    metrics.recordLatencySample(latencySample());

    // Assert - the sample is not lost process-wide, but no per-session entry is
    // created, which is what keeps the map bounded by live rooms.
    expect(
      seriesOf(metrics.snapshot().latency, 'pipeline', 'final')?.count,
    ).toBe(1);
    expect(metrics.sessionLatency(SESSION_UID)).toEqual([]);
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

  it('does not let a returned latency summary mutate with later samples', () => {
    // Arrange - percentiles are derived, so this is the case most likely to
    // hand back a live view by accident.
    const metrics = new NodeServerMetricsService();
    metrics.recordLatencySample(latencySample({ pipelineMs: 10 }));

    // Act
    const taken = metrics.snapshot();
    metrics.recordLatencySample(latencySample({ pipelineMs: 9000 }));

    // Assert
    expect(seriesOf(taken.latency, 'pipeline', 'final')).toMatchObject({
      count: 1,
      sampleCount: 1,
      max: 10,
    });
  });
});
