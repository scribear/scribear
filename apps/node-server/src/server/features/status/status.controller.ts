import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import {
  STATUS_MAX_SESSIONS,
  type STATUS_SCHEMA,
} from '@scribear/node-server-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

/**
 * Serves the process telemetry snapshot consumed by the Monitoring Sidecar
 * (monitoring plan B1.1), replacing the log-text inference it used before.
 *
 * Purely a composition step: process-wide counters come from
 * `NodeServerMetricsService` and live per-session gauges from the
 * orchestrator, which is the only object that holds them. Nothing is computed
 * here beyond joining the two by sessionUid, so the same pair can later feed a
 * Redis publisher without this controller being in the path.
 */
export class StatusController {
  private _metrics: AppDependencies['nodeServerMetricsService'];
  private _orchestrator: AppDependencies['transcriptionOrchestratorService'];

  constructor(
    nodeServerMetricsService: AppDependencies['nodeServerMetricsService'],
    transcriptionOrchestratorService: AppDependencies['transcriptionOrchestratorService'],
  ) {
    this._metrics = nodeServerMetricsService;
    this._orchestrator = transcriptionOrchestratorService;
  }

  status(
    _req: BaseFastifyRequest<typeof STATUS_SCHEMA>,
    res: BaseFastifyReply<typeof STATUS_SCHEMA>,
  ) {
    const counters = this._metrics.snapshot();
    const { sessions, truncated } =
      this._orchestrator.sessionSnapshots(STATUS_MAX_SESSIONS);

    res.code(200).send({
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
      authFailures: counters.authFailures,
      // Subscribers are counted per session by the metrics service, because
      // receive-only connections never reach the orchestrator - they subscribe
      // to the transcript bus directly.
      sessions: sessions.map((session) => ({
        ...session,
        subscriberCount: this._metrics.subscriberCount(session.sessionUid),
      })),
      sessionsTruncated: truncated,
    });
  }
}
