import type { BaseLogger } from '@scribear/base-fastify-server';

import type { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';

/** One monitored service's probe endpoints. */
export interface ProbeTarget {
  /** Compose service name; used as the `service` label. */
  service: string;
  /** Absolute URL of the liveness probe. */
  livenessUrl: string;
  /** Absolute URL of the readiness probe. */
  readinessUrl: string;
}

export interface ProbePollerConfig {
  /** How often to poll every target. */
  intervalMs: number;
  /** Per-request timeout. Must be well under `intervalMs`. */
  timeoutMs: number;
  targets: readonly ProbeTarget[];
}

/** Health of a single probe as of the most recent poll. */
export interface ProbeStatus {
  service: string;
  probe: 'liveness' | 'readiness';
  healthy: boolean;
  /** HTTP status, or null when the request never completed. */
  statusCode: number | null;
  latencyMs: number;
  /** Per-dependency detail from a 503 readiness body, when present. */
  checks: Readonly<Record<string, string>> | null;
  /** Failure description when `healthy` is false. */
  error: string | null;
  consecutiveFailures: number;
  lastCheckedMs: number;
}

/**
 * Actively polls every service's liveness and readiness probes.
 *
 * This is A3, and it covers a real gap: the admin `/health` rollup checks only
 * the database and session-manager, so node-server and transcription-service
 * have no health surface today. It also complements A1 — probes answer "is it
 * up" during the silence that a log-only view cannot distinguish from "healthy
 * but idle".
 */
export class ProbePollerService {
  private _config: ProbePollerConfig;
  private _metrics: MetricsRegistry;
  private _logger: BaseLogger;
  private _statuses = new Map<string, ProbeStatus>();
  private _timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    probePollerConfig: ProbePollerConfig,
    metricsRegistry: MetricsRegistry,
    logger: BaseLogger,
  ) {
    this._config = probePollerConfig;
    this._metrics = metricsRegistry;
    this._logger = logger;
  }

  /** Begins polling. The first sweep runs immediately rather than after a delay. */
  start(): void {
    if (this._timer !== null) return;
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

  /** Runs one full sweep across all targets. Exposed for deterministic tests. */
  async pollOnce(): Promise<ProbeStatus[]> {
    const polls: Promise<ProbeStatus>[] = [];
    for (const target of this._config.targets) {
      polls.push(this._poll(target, 'liveness', target.livenessUrl));
      polls.push(this._poll(target, 'readiness', target.readinessUrl));
    }
    // Targets are polled concurrently: a single hung service must not delay
    // detection of the others, which is the whole point of a short interval.
    return Promise.all(polls);
  }

  /** Current status of every probe, sorted for stable output. */
  statuses(): ProbeStatus[] {
    return [...this._statuses.values()].sort((a, b) =>
      a.service === b.service
        ? a.probe.localeCompare(b.probe)
        : a.service.localeCompare(b.service),
    );
  }

  private async _poll(
    target: ProbeTarget,
    probe: 'liveness' | 'readiness',
    url: string,
  ): Promise<ProbeStatus> {
    const key = `${target.service}:${probe}`;
    const previous = this._statuses.get(key);
    const startedAt = Date.now();

    let healthy = false;
    let statusCode: number | null = null;
    let checks: Record<string, string> | null = null;
    let error: string | null = null;

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(this._config.timeoutMs),
      });
      statusCode = response.status;
      healthy = response.ok;

      // A 503 readiness response carries a `checks` map naming the failing
      // dependency. Surfacing it is what lets the dashboard say "session-manager
      // is down because the database is" instead of just "not ready".
      if (!healthy) {
        const body: unknown = await response.json().catch(() => null);
        if (typeof body === 'object' && body !== null && 'checks' in body) {
          const raw = (body as { checks: unknown }).checks;
          if (typeof raw === 'object' && raw !== null) {
            checks = {};
            for (const [k, v] of Object.entries(raw)) {
              checks[k] = String(v);
            }
          }
        }
        error = `HTTP ${String(statusCode)}`;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const latencyMs = Date.now() - startedAt;
    const consecutiveFailures = healthy
      ? 0
      : (previous?.consecutiveFailures ?? 0) + 1;

    const status: ProbeStatus = {
      service: target.service,
      probe,
      healthy,
      statusCode,
      latencyMs,
      checks,
      error,
      consecutiveFailures,
      lastCheckedMs: startedAt,
    };
    this._statuses.set(key, status);

    const labels = { service: target.service, probe };
    this._metrics.probeUp.set(labels, healthy ? 1 : 0);
    this._metrics.probeLatencyMs.set(labels, latencyMs);
    this._metrics.probeConsecutiveFailures.set(labels, consecutiveFailures);

    // Count edges, not levels: a service that flaps between polls and one that
    // is steadily down look identical in `probe_up` but very different here.
    if (previous !== undefined && previous.healthy !== healthy) {
      this._metrics.probeTransitionsTotal.inc({
        ...labels,
        direction: healthy ? 'up' : 'down',
      });
      this._logger.warn(
        { service: target.service, probe, healthy, error },
        'probe health transition',
      );
    }

    return status;
  }
}
