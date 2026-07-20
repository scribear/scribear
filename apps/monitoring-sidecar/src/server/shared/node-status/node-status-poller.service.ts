import type { Static } from 'typebox';
import { Value } from 'typebox/value';

import type { BaseLogger } from '@scribear/base-fastify-server';
import { STATUS_SCHEMA } from '@scribear/node-server-schema';

import {
  type Counter,
  type Labels,
  seriesKey,
} from '#src/server/shared/metrics/metric-types.js';
import type { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';

/**
 * The 200 body of `GET /api/node-server/v1/status`, derived from the route
 * schema itself rather than restated here — a change to the endpoint's shape
 * becomes a compile error in this file instead of a silently-empty metric.
 */
const STATUS_BODY_SCHEMA = STATUS_SCHEMA.response[200];
type NodeStatusBody = Static<typeof STATUS_BODY_SCHEMA>;

export interface NodeStatusPollerConfig {
  /**
   * False when no service API key is configured. The poller then does nothing
   * at all rather than issuing 401s forever — the same fail-closed choice the
   * canary makes about its device token.
   */
  enabled: boolean;
  intervalMs: number;
  /** Per-request timeout. Must be well under `intervalMs`. */
  timeoutMs: number;
  /** Value of the `service` label on every metric this poller writes. */
  service: string;
  statusUrl: string;
  serviceApiKey: string;
}

/** Outcome of the most recent poll, for the readiness surface and tests. */
export interface NodeStatusPollResult {
  ok: boolean;
  /** Failure category when `ok` is false; one of {@link POLL_ERROR_REASONS}. */
  reason: string | null;
  /** Process identity reported by node-server, when the poll succeeded. */
  processUid: string | null;
  /** True when this poll observed a different process than the last one. */
  restarted: boolean;
}

/**
 * Failure categories. Kept to a closed set because they become a metric label;
 * using the raw error text would let a flapping DNS resolver create unbounded
 * series.
 */
const POLL_ERROR_REASONS = {
  UNREACHABLE: 'unreachable',
  UNAUTHORIZED: 'unauthorized',
  HTTP_ERROR: 'http-error',
  MALFORMED: 'malformed',
} as const;

/**
 * Polls node-server's status endpoint and folds it into the metric registry.
 *
 * **Why this exists.** Before B1.1 the sidecar inferred WebSocket closes,
 * upstream churn, upstream state and node-side decode drops by pattern-matching
 * log text. That worked, but it was lossy by construction — it depended on the
 * log level, on the collector being attached for the whole window, and on
 * nothing rotating out — and several signals (subscriber counts, auth
 * successes, pending-chunk evictions, clock-skew discards) had no log line at
 * all. Those four metrics now come from here; the log parsers for them are
 * gone, and the node-server log lines remain purely as forensics.
 *
 * **Absolute vs incremental.** The endpoint reports counters that are monotonic
 * since node-server booted, so this poller cannot simply `inc()` what it reads:
 * it tracks the previous absolute per series and applies only the difference.
 * That keeps the sidecar's own counters monotonic and keeps the rolling windows
 * the alert rules depend on meaningful.
 *
 * **Restarts.** A restarted node-server reports every counter back at zero,
 * which naively differenced would be a large negative rate. `processUid`
 * changes on every boot, so a change rebases every series to zero and the
 * freshly-read totals are attributed in full — they are all events this sidecar
 * has not seen. That attributes a restart's pre-detection events to the moment
 * of detection rather than to when they happened, which is a small and
 * deliberate distortion of the rolling window; the alternative is discarding
 * them.
 */
export class NodeStatusPollerService {
  private _config: NodeStatusPollerConfig;
  private _metrics: MetricsRegistry;
  private _logger: BaseLogger;

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _lastResult: NodeStatusPollResult | null = null;
  /** Previous absolute value per counter series, keyed `metric|seriesKey`. */
  private _lastAbsolute = new Map<string, number>();
  private _processUid: string | null = null;
  /** Sessions present in the previous poll, so vanished ones can be removed. */
  private _knownSessions = new Set<string>();

  constructor(
    nodeStatusPollerConfig: NodeStatusPollerConfig,
    metricsRegistry: MetricsRegistry,
    logger: BaseLogger,
  ) {
    this._config = nodeStatusPollerConfig;
    this._metrics = metricsRegistry;
    this._logger = logger;
  }

  /** Begins polling. The first poll runs immediately rather than after a delay. */
  start(): void {
    if (this._timer !== null) return;
    if (!this._config.enabled) {
      this._logger.warn(
        'node-server status polling disabled: NODE_SERVER_SERVICE_API_KEY is unset. Connection, upstream and auth metrics will be empty.',
      );
      return;
    }
    void this.pollOnce();
    this._timer = setInterval(() => {
      void this.pollOnce();
    }, this._config.intervalMs);
    // Do not hold the event loop open on this timer alone.
    this._timer.unref();
  }

  stop(): void {
    if (this._timer === null) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  /** Most recent poll outcome, or null before the first poll. */
  get lastResult(): NodeStatusPollResult | null {
    return this._lastResult;
  }

  /** Runs one poll. Exposed so tests can drive it deterministically. */
  async pollOnce(): Promise<NodeStatusPollResult> {
    const body = await this._fetchStatus();
    if (typeof body === 'string') return this._recordFailure(body);

    const restarted =
      this._processUid !== null && this._processUid !== body.processUid;
    if (restarted) {
      // Every series starts again from zero in the new process, so forget the
      // baselines rather than differencing against a dead process's totals.
      this._lastAbsolute.clear();
      this._metrics.nodeProcessRestartsTotal.inc({
        service: this._config.service,
      });
      this._logger.warn(
        { previous: this._processUid, current: body.processUid },
        'node-server restarted; rebasing status counters',
      );
    }
    this._processUid = body.processUid;

    this._applyCounters(body);
    this._applySessionGauges(body);

    this._metrics.nodeStatusUp.set({ service: this._config.service }, 1);
    this._lastResult = {
      ok: true,
      reason: null,
      processUid: body.processUid,
      restarted,
    };
    return this._lastResult;
  }

  /** Returns the parsed body, or a {@link POLL_ERROR_REASONS} value on failure. */
  private async _fetchStatus(): Promise<NodeStatusBody | string> {
    let response: Response;
    try {
      response = await fetch(this._config.statusUrl, {
        headers: { authorization: `Bearer ${this._config.serviceApiKey}` },
        signal: AbortSignal.timeout(this._config.timeoutMs),
      });
    } catch {
      return POLL_ERROR_REASONS.UNREACHABLE;
    }

    if (!response.ok) {
      return response.status === 401 || response.status === 403
        ? POLL_ERROR_REASONS.UNAUTHORIZED
        : POLL_ERROR_REASONS.HTTP_ERROR;
    }

    const parsed: unknown = await response.json().catch(() => null);
    // Validated against the real route schema: a node-server on a newer or
    // older contract must fail loudly here rather than half-populate metrics.
    if (!Value.Check(STATUS_BODY_SCHEMA, parsed)) {
      return POLL_ERROR_REASONS.MALFORMED;
    }
    return parsed;
  }

  private _recordFailure(reason: string): NodeStatusPollResult {
    const service = this._config.service;
    this._metrics.nodeStatusPollErrorsTotal.inc({ service, reason });
    this._metrics.nodeStatusUp.set({ service }, 0);

    // Log the transition, not every failed poll: at a 10 s cadence a sustained
    // outage would otherwise write thousands of identical lines.
    if (this._lastResult?.ok !== false) {
      this._logger.warn(
        { reason, url: this._config.statusUrl },
        'node-server status poll failed',
      );
    }

    this._lastResult = {
      ok: false,
      reason,
      processUid: null,
      restarted: false,
    };
    return this._lastResult;
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

  /**
   * Folds one absolute total into a counter by adding the difference since the
   * previous poll.
   *
   * A value below the previous one means node-server restarted between polls
   * without us catching the `processUid` change; the reading is then treated as
   * a fresh process's total rather than producing a negative increment.
   */
  private _advance(counter: Counter, labels: Labels, absolute: number): void {
    const key = `${counter.name}|${seriesKey(labels)}`;
    const previous = this._lastAbsolute.get(key) ?? 0;
    const delta = absolute >= previous ? absolute - previous : absolute;
    this._lastAbsolute.set(key, absolute);
    if (delta > 0) counter.inc(labels, delta);
  }
}
