import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import { STATUS_SCHEMA } from '@scribear/node-server-schema';

import {
  AbsoluteStatusPoller,
  type AbsoluteStatusPollerConfig,
} from '#src/server/shared/status-poll/absolute-status-poller.js';

/**
 * The 200 body of `GET /api/node-server/v1/status`, derived from the route
 * schema itself rather than restated here — a change to the endpoint's shape
 * becomes a compile error in this file instead of a silently-empty metric.
 */
const STATUS_BODY_SCHEMA = STATUS_SCHEMA.response[200];
type NodeStatusBody = Static<typeof STATUS_BODY_SCHEMA>;

export type NodeStatusPollerConfig = AbsoluteStatusPollerConfig;

/**
 * Folds node-server's status endpoint into the registry (B1.1).
 *
 * Transport, auth, restart rebasing and absolute-to-delta arithmetic all live
 * in {@link AbsoluteStatusPoller}; what is node-server-specific is the body
 * schema and the session gauges below.
 */
export class NodeStatusPollerService extends AbsoluteStatusPoller<NodeStatusBody> {
  /** Sessions present in the previous poll, so vanished ones can be removed. */
  private _knownSessions = new Set<string>();

  protected _parseBody(parsed: unknown): NodeStatusBody | null {
    return Value.Check(STATUS_BODY_SCHEMA, parsed) ? parsed : null;
  }

  protected readonly _disabledWarning =
    'node-server status polling disabled: NODE_SERVER_SERVICE_API_KEY is unset. Connection, upstream and auth metrics will be empty.';

  protected _apply(body: NodeStatusBody): void {
    this._applyCounters(body);
    this._applySessionGauges(body);
  }

  private _applyCounters(body: NodeStatusBody): void {
    const service = this._config.service;
    const s = body.summary;

    this._advance(
      this._metrics.safpDecodeDropsTotal,
      { service, side: 'node' },
      s.decodeDropsTotal,
    );
    this._advance(
      this._metrics.upstreamChurnTotal,
      { service },
      s.upstreamChurnTotal,
    );
    this._advance(
      this._metrics.nodeAuthSuccessTotal,
      { service },
      s.authSuccessTotal,
    );
    this._advance(
      this._metrics.nodeAuthTimeoutsTotal,
      { service },
      s.authTimeoutsTotal,
    );
    this._advance(
      this._metrics.nodeOrchestratorFailuresTotal,
      { service },
      s.orchestratorFailuresTotal,
    );
    this._advance(
      this._metrics.nodePendingChunkEvictionsTotal,
      { service },
      s.pendingChunkEvictionsTotal,
    );
    this._advance(
      this._metrics.nodeLatencySamplesTotal,
      { service },
      s.latencySamplesTotal,
    );
    this._advance(
      this._metrics.nodeLatencyE2eNegativeTotal,
      { service },
      s.latencyE2eNegativeTotal,
    );
    this._advance(
      this._metrics.nodeLatencyE2eUnavailableTotal,
      { service },
      s.latencyE2eUnavailableTotal,
    );
    this._advance(
      this._metrics.nodeLatencyUnmatchedChunkTotal,
      { service },
      s.latencyUnmatchedChunkTotal,
    );

    for (const t of body.upstreamStateTransitions) {
      this._advance(
        this._metrics.upstreamStateTotal,
        { service, from: t.from, to: t.to },
        t.count,
      );
    }
    for (const c of body.wsCloses) {
      this._advance(
        this._metrics.wsCloseTotal,
        {
          service,
          code: String(c.code),
          reason: c.reason,
          role: c.role,
          initiator: c.initiator,
        },
        c.count,
      );
    }
    for (const f of body.authFailures) {
      this._advance(
        this._metrics.nodeAuthFailuresTotal,
        { service, reason: f.reason },
        f.count,
      );
    }
  }

  private _applySessionGauges(body: NodeStatusBody): void {
    const service = this._config.service;
    this._metrics.nodeActiveSessions.set(
      { service },
      body.summary.activeSessionCount,
    );

    const seen = new Set<string>();
    for (const session of body.sessions) {
      const labels = { service, sessionUid: session.sessionUid };
      seen.add(session.sessionUid);
      this._metrics.nodeSessionSources.set(labels, session.sourceCount);
      this._metrics.nodeSessionSubscribers.set(labels, session.subscriberCount);
      this._metrics.nodeSessionPendingChunks.set(
        labels,
        session.pendingChunkCount,
      );
      this._metrics.nodeSessionUpstreamUp.set(
        labels,
        session.upstreamState === 'OPEN' ? 1 : 0,
      );
      this._metrics.nodeSessionUpstreamRetryAttempt.set(
        labels,
        session.upstreamRetryAttempt,
      );
    }

    // Sessions that ended must stop being reported. A gauge left behind would
    // claim a room is still connected long after everyone went home. Truncated
    // responses are the one case where a live session can be absent, so leave
    // the existing series alone rather than deleting a session we simply were
    // not told about.
    if (!body.sessionsTruncated) {
      for (const sessionUid of this._knownSessions) {
        if (seen.has(sessionUid)) continue;
        const labels = { service, sessionUid };
        this._metrics.nodeSessionSources.delete(labels);
        this._metrics.nodeSessionSubscribers.delete(labels);
        this._metrics.nodeSessionPendingChunks.delete(labels);
        this._metrics.nodeSessionUpstreamUp.delete(labels);
        this._metrics.nodeSessionUpstreamRetryAttempt.delete(labels);
      }
      this._knownSessions = seen;
    } else {
      for (const sessionUid of seen) this._knownSessions.add(sessionUid);
    }
  }
}
