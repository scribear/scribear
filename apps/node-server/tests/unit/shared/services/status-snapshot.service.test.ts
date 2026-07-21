import { describe, expect } from 'vitest';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import type { SessionSnapshot } from '#src/server/features/transcription-stream/transcription-orchestrator.service.js';
import { NodeServerMetricsService } from '#src/server/shared/services/node-server-metrics.service.js';
import { StatusSnapshotService } from '#src/server/shared/services/status-snapshot.service.js';

const SESSION_UID = '00000000-0000-0000-0000-000000000abc';

function gauges(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionUid: SESSION_UID,
    providerKey: 'whisper',
    sourceCount: 1,
    pendingChunkCount: 3,
    upstreamState: 'OPEN',
    upstreamRetryAttempt: 0,
    ...overrides,
  };
}

function buildService(sessions: SessionSnapshot[], truncated = false) {
  const metrics = new NodeServerMetricsService();
  const orchestrator = {
    activeSessionCount: sessions.length,
    sessionSnapshots: (limit: number) => ({
      sessions: sessions.slice(0, limit),
      truncated,
    }),
  } as unknown as AppDependencies['transcriptionOrchestratorService'];
  return {
    metrics,
    service: new StatusSnapshotService(metrics, orchestrator),
  };
}

describe('StatusSnapshotService', (it) => {
  it('joins the orchestrator’s gauges with the counters kept beside them', () => {
    // Arrange - subscriber counts and latency live in the metrics service
    // because receive-only connections never reach the orchestrator.
    const { metrics, service } = buildService([gauges()]);
    metrics.recordConnectionOpen(SESSION_UID);
    metrics.recordConnectionOpen(SESSION_UID);

    // Act
    const { sessions, truncated } = service.sessions(200);

    // Assert
    expect(sessions).toStrictEqual([
      { ...gauges(), subscriberCount: 2, latency: [] },
    ]);
    expect(truncated).toBe(false);
  });

  it('reports a session the orchestrator holds but no connection subscribes to', () => {
    // Arrange - the two maps have different lifetimes, so a session can be in
    // one and not the other; a missing entry is zero, not an omitted session.
    const { service } = buildService([gauges()]);

    // Act
    const { sessions } = service.sessions(200);

    // Assert
    expect(sessions[0]?.subscriberCount).toBe(0);
    expect(sessions[0]?.latency).toStrictEqual([]);
  });

  it('passes the cap to the orchestrator and reports whether it bit', () => {
    // Arrange - capping inside the orchestrator is what keeps a large fleet of
    // sessions from materializing an array we intend to discard.
    const { service } = buildService(
      [gauges(), gauges({ sessionUid: 'other' })],
      true,
    );

    // Act
    const { sessions, truncated } = service.sessions(1);

    // Assert
    expect(sessions).toHaveLength(1);
    expect(truncated).toBe(true);
  });

  it('stamps generatedAt and reports the live session count', () => {
    // Arrange
    const { metrics, service } = buildService([gauges()]);
    metrics.recordDecodeDrop();

    // Act
    const snapshot = service.process();

    // Assert - `generatedAt` dates the numbers, letting a consumer bound their
    // age independently of its own clock.
    expect(Date.parse(snapshot.generatedAt)).not.toBeNaN();
    expect(snapshot.processUid).toBe(metrics.processUid);
    expect(snapshot.summary.activeSessionCount).toBe(1);
    expect(snapshot.summary.decodeDropsTotal).toBe(1);
  });
});
