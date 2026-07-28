import type { BaseLogger } from '@scribear/base-fastify-server';

import {
  type Counter,
  type Labels,
  seriesKey,
} from '#src/server/shared/metrics/metric-types.js';
import type { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';

export interface AbsoluteStatusPollerConfig {
  /**
   * False when no API key is configured. The poller then does nothing at all
   * rather than issuing 401s forever — the same fail-closed choice the canary
   * makes about its device token.
   */
  enabled: boolean;
  intervalMs: number;
  /** Per-request timeout. Must be well under `intervalMs`. */
  timeoutMs: number;
  /** Value of the `service` label on every metric this poller writes. */
  service: string;
  statusUrl: string;
  apiKey: string;
}

/** Outcome of the most recent poll, for the readiness surface and tests. */
export interface StatusPollResult {
  ok: boolean;
  /** Failure category when `ok` is false; one of {@link POLL_ERROR_REASONS}. */
  reason: string | null;
  /** Process identity reported by the polled service, when the poll succeeded. */
  processUid: string | null;
  /** True when this poll observed a different process than the last one. */
  restarted: boolean;
}

/**
 * Failure categories. Kept to a closed set because they become a metric label;
 * using the raw error text would let a flapping DNS resolver create unbounded
 * series.
 *
 * `not-found` is its own category rather than an `http-error`:
 * transcription-service deliberately leaves `/metrics/status` unregistered when
 * its own key is empty, so a 404 means "the endpoint is switched off at the
 * far end", which is a configuration answer and not a transport fault.
 */
export const POLL_ERROR_REASONS = {
  UNREACHABLE: 'unreachable',
  UNAUTHORIZED: 'unauthorized',
  NOT_FOUND: 'not-found',
  HTTP_ERROR: 'http-error',
  MALFORMED: 'malformed',
} as const;

/**
 * Polls a service's authed status endpoint and folds absolute counters into the
 * metric registry as increments.
 *
 * **Why this exists.** Before B1.1 the sidecar inferred connection state,
 * upstream churn, decode drops and transcription job timings by pattern-matching
 * log text. That worked, but it was lossy by construction — it depended on the
 * log level, on the collector being attached for the whole window, and on
 * nothing rotating out — and several signals (subscriber counts, auth
 * successes, pending-chunk evictions, clock-skew discards, true RTF) had no log
 * line at all. Both node-server (B1.1) and transcription-service (B1.2) now
 * report them as authoritative in-process counters instead.
 *
 * **Absolute vs incremental.** Endpoints report counters that are monotonic
 * since the reporting process booted, so a poller cannot simply `inc()` what it
 * reads: it tracks the previous absolute per series and applies only the
 * difference. That keeps the sidecar's own counters monotonic and keeps the
 * rolling windows the alert rules depend on meaningful.
 *
 * **Restarts.** A restarted service reports every counter back at zero, which
 * naively differenced would be a large negative rate. `processUid` changes on
 * every boot, so a change rebases every series and the freshly-read totals are
 * attributed in full — they are all events this sidecar has not seen. That
 * attributes a restart's pre-detection events to the moment of detection rather
 * than to when they happened, which is a small and deliberate distortion of the
 * rolling window; the alternative is discarding them.
 *
 * **What subclasses own.** Only the body: its schema (via {@link _parseBody}),
 * the disabled warning, and folding a validated body into metrics (via
 * {@link _apply}). Transport, auth, the closed error set, transition-only
 * logging, restart detection and the absolute-to-delta arithmetic are all here
 * and identical for every service.
 */
export abstract class AbsoluteStatusPoller<
  TBody extends { processUid: string },
> {
  protected readonly _config: AbsoluteStatusPollerConfig;
  protected readonly _metrics: MetricsRegistry;
  protected readonly _logger: BaseLogger;

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _lastResult: StatusPollResult | null = null;
  /** Previous absolute value per counter series, keyed `metric|seriesKey`. */
  private _lastAbsolute = new Map<string, number>();
  private _processUid: string | null = null;
  /**
   * True while the first successful poll is being folded, so {@link _advance}
   * records baselines without emitting increments. See its doc for why.
   */
  private _priming = true;

  constructor(
    config: AbsoluteStatusPollerConfig,
    metricsRegistry: MetricsRegistry,
    logger: BaseLogger,
  ) {
    this._config = config;
    this._metrics = metricsRegistry;
    this._logger = logger;
  }

  /**
   * Validates a decoded JSON body against this service's contract, returning
   * null if it does not match. Implementations should use a TypeBox
   * `Value.Check`, which narrows the type as a side effect.
   */
  protected abstract _parseBody(parsed: unknown): TBody | null;

  /** Warning logged once when the poller starts without a key. */
  protected abstract readonly _disabledWarning: string;

  /** Folds a validated body into the registry. */
  protected abstract _apply(body: TBody): void;

  /** Begins polling. The first poll runs immediately rather than after a delay. */
  start(): void {
    if (this._timer !== null) return;
    if (!this._config.enabled) {
      this._logger.warn(this._disabledWarning);
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
  get lastResult(): StatusPollResult | null {
    return this._lastResult;
  }

  /**
   * False when this poller was constructed with no API key, and so will never
   * poll at all — distinct from `lastResult === null`, which a consumer could
   * otherwise not tell apart from "enabled, but the first poll has not
   * completed yet".
   */
  get enabled(): boolean {
    return this._config.enabled;
  }

  /** Runs one poll. Exposed so tests can drive it deterministically. */
  async pollOnce(): Promise<StatusPollResult> {
    const body = await this._fetchStatus();
    if (typeof body === 'string') return this._recordFailure(body);

    const restarted =
      this._processUid !== null && this._processUid !== body.processUid;
    if (restarted) {
      // Every series starts again from zero in the new process, so forget the
      // baselines rather than differencing against a dead process's totals.
      this._lastAbsolute.clear();
      this._metrics.serviceProcessRestartsTotal.inc({
        service: this._config.service,
      });
      this._logger.warn(
        {
          service: this._config.service,
          previous: this._processUid,
          current: body.processUid,
        },
        'polled service restarted; rebasing status counters',
      );
    }
    this._processUid = body.processUid;

    this._apply(body);
    // Only the first fold primes. Gauges set by `_apply` are unaffected — they
    // carry no history — so a primed poll still publishes a full picture of the
    // service's current state; it is only the counter *deltas* that are skipped.
    this._priming = false;

    this._metrics.serviceStatusUp.set({ service: this._config.service }, 1);
    this._lastResult = {
      ok: true,
      reason: null,
      processUid: body.processUid,
      restarted,
    };
    return this._lastResult;
  }

  /** Returns the parsed body, or a {@link POLL_ERROR_REASONS} value on failure. */
  private async _fetchStatus(): Promise<TBody | string> {
    let response: Response;
    try {
      response = await fetch(this._config.statusUrl, {
        headers: { authorization: `Bearer ${this._config.apiKey}` },
        signal: AbortSignal.timeout(this._config.timeoutMs),
      });
    } catch {
      return POLL_ERROR_REASONS.UNREACHABLE;
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return POLL_ERROR_REASONS.UNAUTHORIZED;
      }
      if (response.status === 404) return POLL_ERROR_REASONS.NOT_FOUND;
      return POLL_ERROR_REASONS.HTTP_ERROR;
    }

    const parsed: unknown = await response.json().catch(() => null);
    // Validated against the service's declared contract: a service on a newer
    // or older shape must fail loudly here rather than half-populate metrics.
    const body = this._parseBody(parsed);
    return body ?? POLL_ERROR_REASONS.MALFORMED;
  }

  private _recordFailure(reason: string): StatusPollResult {
    const service = this._config.service;
    this._metrics.serviceStatusPollErrorsTotal.inc({ service, reason });
    this._metrics.serviceStatusUp.set({ service }, 0);

    // Log the transition, not every failed poll: at a 10 s cadence a sustained
    // outage would otherwise write thousands of identical lines.
    if (this._lastResult?.ok !== false) {
      this._logger.warn(
        { service, reason, url: this._config.statusUrl },
        'service status poll failed',
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

  /**
   * Folds one absolute total into a counter by adding the difference since the
   * previous poll.
   *
   * A value below the previous one means the service restarted between polls
   * without us catching the `processUid` change; the reading is then treated as
   * a fresh process's total rather than producing a negative increment.
   *
   * **The very first poll of this poller's life only records baselines.** The
   * polled service's counters are lifetime totals, so without this a sidecar
   * started beside a long-running service folds that service's entire history
   * into one increment stamped `now` — and every raw windowed rule
   * (`decodeDropRule` at 10, `bufferOverflowRule` at 5, `upstreamChurnRule` at 3)
   * fires immediately on counts that predate the sidecar by days, then clears
   * itself one window later. Those counts belong to before anyone was watching.
   *
   * A *service* restart is the opposite case and is handled by
   * {@link pollOnce} clearing the baselines: the service's own counters really
   * are near zero then, so differencing against zero attributes only what it has
   * accrued since, which is genuinely inside the window.
   *
   * The cost is that up to one poll interval of counts is lost at startup. That
   * is the correct trade for a rate rule, and the ratio rules
   * ({@link authFailureRule}, and the dropped-period shares) were already immune
   * because a lifetime fold lands in both numerator and denominator.
   */
  protected _advance(counter: Counter, labels: Labels, absolute: number): void {
    const key = `${counter.name}|${seriesKey(labels)}`;
    const previous = this._lastAbsolute.get(key) ?? 0;
    const delta = absolute >= previous ? absolute - previous : absolute;
    this._lastAbsolute.set(key, absolute);
    if (this._priming) return;
    if (delta > 0) counter.inc(labels, delta);
  }
}
