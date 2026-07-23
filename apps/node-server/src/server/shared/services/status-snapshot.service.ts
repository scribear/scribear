import {
  type StatusProcess,
  type StatusSession,
} from '@scribear/node-server-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

/**
 * Assembles this process's telemetry from the two objects that hold it.
 *
 * The split is by lifetime, not by subject: `NodeServerMetricsService` owns
 * everything monotonic plus the per-session figures that outlive the
 * orchestrator's view of a session (subscriber counts include receive-only
 * connections, which never reach the orchestrator, and latency windows are
 * kept beside them), while the orchestrator owns the live gauges only it can
 * see. Every consumer wants them joined, so the join lives here rather than in
 * any one consumer: `GET /status` serves it over HTTP and the Redis telemetry
 * publisher writes the same records to the backplane, and neither is in the
 * other's path (B1.7 §2.3).
 */
export class StatusSnapshotService {
  private _metrics: AppDependencies['nodeServerMetricsService'];
  private _orchestrator: AppDependencies['transcriptionOrchestratorService'];

  constructor(
    nodeServerMetricsService: AppDependencies['nodeServerMetricsService'],
    transcriptionOrchestratorService: AppDependencies['transcriptionOrchestratorService'],
  ) {
    this._metrics = nodeServerMetricsService;
    this._orchestrator = transcriptionOrchestratorService;
  }

  /**
   * Process-wide counters and distributions, excluding the session list.
   *
   * `generatedAt` is stamped here, so it dates the numbers rather than the
   * response that carries them.
   */
  process(): StatusProcess {
    const counters = this._metrics.snapshot();
    return {
      processUid: counters.processUid,
      processStartedAt: counters.processStartedAt,
      generatedAt: new Date().toISOString(),
      summary: {
        activeSessionCount: this._orchestrator.activeSessionCount,
        decodeDropsTotal: counters.decodeDropsTotal,
        pendingChunkEvictionsTotal: counters.pendingChunkEvictionsTotal,
        upstreamChurnTotal: counters.upstreamChurnTotal,
        authSuccessTotal: counters.authSuccessTotal,
        authTimeoutsTotal: counters.authTimeoutsTotal,
        orchestratorFailuresTotal: counters.orchestratorFailuresTotal,
        latencySamplesTotal: counters.latencySamplesTotal,
        latencyE2eUnavailableTotal: counters.latencyE2eUnavailableTotal,
        latencyE2eNegativeTotal: counters.latencyE2eNegativeTotal,
        latencyUnmatchedChunkTotal: counters.latencyUnmatchedChunkTotal,
      },
      upstreamStateTransitions: counters.upstreamStateTransitions,
      wsCloses: counters.wsCloses,
      latency: counters.latency,
      authFailures: counters.authFailures,
    };
  }

  /**
   * Live gauges for each active session, capped at `limit`.
   *
   * The cap is applied inside the orchestrator so a large fleet of sessions
   * never materializes an array we intend to discard; `truncated` reports
   * whether it bit, because a silent cap reads as "that is all of them".
   *
   * @param limit Maximum number of sessions to return.
   */
  sessions(limit: number): {
    sessions: StatusSession[];
    truncated: boolean;
  } {
    const { sessions, truncated } = this._orchestrator.sessionSnapshots(limit);
    return {
      sessions: sessions.map((session) => ({
        ...session,
        subscriberCount: this._metrics.subscriberCount(session.sessionUid),
        latency: this._metrics.sessionLatency(session.sessionUid),
      })),
      truncated,
    };
  }
}
