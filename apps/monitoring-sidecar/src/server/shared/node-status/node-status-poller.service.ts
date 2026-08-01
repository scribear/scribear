import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import type { BaseLogger } from '@scribear/base-fastify-server';
import {
  STATUS_SCHEMA,
  type SecretPlaceholders,
} from '@scribear/node-server-schema';

import type { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';
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
 * Quantiles mirrored as gauge series, matching the transcription-service
 * poller so both services' latency panels can query the same `quantile` label
 * values.
 */
const QUANTILES = ['p50', 'p95', 'p99', 'max'] as const;

/** Joins `(measure, kind)` into one bookkeeping key. Neither value contains it. */
const SERIES_KEY_SEPARATOR = '/';

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

  /**
   * The most recently polled secret-placeholder classification
   * (PLAN-ConfigCheck-Coverage Phase 2), or null before the first successful
   * poll. Not a metric — folding it into `MetricsRegistry` would wrongly gate
   * Config Check's findings behind the optional `monitoring`/Prometheus
   * profile — so it is stashed here instead, the same way `lastResult` is,
   * and re-exposed directly by `ConfigAuditController`.
   */
  private _secretPlaceholders: SecretPlaceholders | null = null;

  // Own constructor solely so Awilix (CLASSIC mode, resolves by parameter name)
  // sees a first parameter named `nodeStatusPollerConfig`, matching the
  // registration key. Without it the class inherits the base constructor whose
  // parameter is `config`, which is not registered, and resolution fails with
  // `Could not resolve 'config'`. The sibling pollers do the same. It forwards
  // to super unchanged, which reads as useless to eslint but is load-bearing
  // for DI — the parameter name is the whole point.
  // eslint-disable-next-line @typescript-eslint/no-useless-constructor
  constructor(
    nodeStatusPollerConfig: NodeStatusPollerConfig,
    metricsRegistry: MetricsRegistry,
    logger: BaseLogger,
  ) {
    super(nodeStatusPollerConfig, metricsRegistry, logger);
  }

  protected _parseBody(parsed: unknown): NodeStatusBody | null {
    return Value.Check(STATUS_BODY_SCHEMA, parsed) ? parsed : null;
  }

  protected readonly _disabledWarning =
    'node-server status polling disabled: NODE_SERVER_SERVICE_API_KEY is unset. Connection, upstream and auth metrics will be empty.';

  /** Kinds seen in the previous poll, so a kind that stopped can be removed. */
  private _knownLatencyKinds = new Set<string>();

  /** @see {@link _secretPlaceholders} */
  get secretPlaceholders(): SecretPlaceholders | null {
    return this._secretPlaceholders;
  }

  protected _apply(body: NodeStatusBody): void {
    this._applyCounters(body);
    this._applySessionGauges(body);
    this._applyLatencyQuantiles(body);
    this._secretPlaceholders = body.secretPlaceholders;
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
    // Optional on the wire: absent from a node-server that predates the
    // counter. Skipping the advance entirely (rather than defaulting to 0)
    // means a mixed-version fleet neither throws nor silently zeroes a delta
    // against whatever this series last held.
    if (s.binaryBeforeAuthDropsTotal !== undefined) {
      this._advance(
        this._metrics.nodeBinaryBeforeAuthDropsTotal,
        { service },
        s.binaryBeforeAuthDropsTotal,
      );
    }
    this._advance(
      this._metrics.nodeOrchestratorFailuresTotal,
      { service },
      s.orchestratorFailuresTotal,
    );
    // Optional on the wire, skipped rather than defaulted - same reasoning as
    // `binaryBeforeAuthDropsTotal` above.
    if (s.endedSessionRegistrationsTotal !== undefined) {
      this._advance(
        this._metrics.nodeEndedSessionRegistrationsTotal,
        { service },
        s.endedSessionRegistrationsTotal,
      );
    }
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

  /**
   * Process-wide latency percentiles (B1.4).
   *
   * Only the process-wide block is folded in; per-session percentiles stay on
   * node-server's `/status` for the fleet SPA, because mirroring them would add
   * a dozen series per live room to every scrape.
   */
  private _applyLatencyQuantiles(body: NodeStatusBody): void {
    const service = this._config.service;
    const seen = new Set<string>();

    for (const series of body.latency) {
      // A series with nothing retained carries meaningless zeroes.
      if (series.sampleCount === 0) continue;
      const gauge =
        series.measure === 'pipeline'
          ? this._metrics.nodePipelineLatencyMs
          : this._metrics.nodeE2eLatencyMs;
      seen.add(`${series.measure}${SERIES_KEY_SEPARATOR}${series.kind}`);
      for (const quantile of QUANTILES) {
        gauge.set({ service, kind: series.kind, quantile }, series[quantile]);
      }
    }

    // A series that stopped being reported must stop being exported: node-server
    // drops a series only when the process restarts, but a stale p95 left behind
    // would keep a latency alert firing long after the traffic stopped.
    for (const key of this._knownLatencyKinds) {
      if (seen.has(key)) continue;
      const [measure = '', kind = ''] = key.split(SERIES_KEY_SEPARATOR);
      const gauge =
        measure === 'pipeline'
          ? this._metrics.nodePipelineLatencyMs
          : this._metrics.nodeE2eLatencyMs;
      for (const quantile of QUANTILES) {
        gauge.delete({ service, kind, quantile });
      }
    }
    this._knownLatencyKinds = seen;
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
