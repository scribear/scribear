import { sql } from 'kysely';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

/**
 * Health of one dependency.
 *
 * - `ok` — answered, and said it was healthy.
 * - `degraded` — answered, and said it was working but impaired. Since B1.3
 *   transcription-service reports this when every worker is saturated.
 * - `fail` — answered, and said it was unhealthy (a 503 readiness).
 * - `unreachable` — did not answer at all: refused, timed out, or returned
 *   something unrecognizable.
 *
 * The distinction that matters operationally is `fail` vs `unreachable`: the
 * first means the service is running and telling you what is wrong, the second
 * means you cannot even ask.
 */
export type ComponentStatus = 'ok' | 'degraded' | 'unreachable' | 'fail';

export interface HealthComponent {
  /** Stable identifier, matching the compose service name where there is one. */
  name: string;
  status: ComponentStatus;
  latencyMs: number;
  /** One-line elaboration when the component is not `ok`; omitted when it is. */
  detail?: string | undefined;
}

export interface ProbeTarget {
  name: string;
  readinessUrl: string;
}

export interface HealthCheckerConfig {
  /**
   * Per-component timeout. Must stay well under the SPA's own patience: the
   * components are checked concurrently, so this is the worst case for the
   * whole rollup, not per component.
   */
  timeoutMs: number;
  targets: ProbeTarget[];
}

/** Shape every service's readiness endpoint answers with. */
interface ReadinessBody {
  status?: unknown;
  checks?: Record<string, unknown>;
}

/**
 * Builds the admin `/health` rollup (B1.5).
 *
 * **Why raw `fetch` rather than the generated clients.** Only session-manager
 * has one, and `createEndpointClient` issues a bare `fetch` with no
 * `AbortSignal` unless a caller passes one — which the health path did not, so
 * before B1.5 a hung session-manager could stall this route for the OS TCP
 * timeout with an admin waiting on it. Probe endpoints are unauthenticated and
 * their bodies are two fields, so the typed client buys little here and a
 * uniform hard timeout across all three services buys a lot. This mirrors what
 * the monitoring-sidecar's probe poller already does.
 *
 * **Why the components are a list rather than named fields.** The old response
 * had `sessionManager` and `sessionManagerLatencyMs` as flat keys, which meant
 * every new dependency needed a schema change, an SPA type change, and a new
 * hardcoded tile. B1.5 alone would have tripled that, and B1.7's per-provider
 * health would again. A list renders generically.
 */
export class HealthCheckerService {
  private _config: HealthCheckerConfig;
  private _dbClient: AppDependencies['dbClient'];

  constructor(
    healthCheckerConfig: HealthCheckerConfig,
    dbClient: AppDependencies['dbClient'],
  ) {
    this._config = healthCheckerConfig;
    this._dbClient = dbClient;
  }

  /**
   * Checks every dependency concurrently.
   *
   * Concurrent rather than sequential because the slowest component would
   * otherwise set the floor for the whole page: four sequential 3-second
   * timeouts is a 12-second admin dashboard.
   */
  async check(): Promise<HealthComponent[]> {
    const [database, ...probed] = await Promise.all([
      this._checkDatabase(),
      ...this._config.targets.map((target) => this._checkProbe(target)),
    ]);
    return [database, ...probed];
  }

  private async _checkDatabase(): Promise<HealthComponent> {
    const start = Date.now();
    try {
      await sql`SELECT 1`.execute(this._dbClient.db);
      return { name: 'database', status: 'ok', latencyMs: Date.now() - start };
    } catch (err) {
      return {
        name: 'database',
        status: 'fail',
        latencyMs: Date.now() - start,
        detail: err instanceof Error ? err.message : 'query failed',
      };
    }
  }

  private async _checkProbe(target: ProbeTarget): Promise<HealthComponent> {
    const start = Date.now();
    let response: Response;
    try {
      response = await fetch(target.readinessUrl, {
        signal: AbortSignal.timeout(this._config.timeoutMs),
      });
    } catch (err) {
      return {
        name: target.name,
        status: 'unreachable',
        latencyMs: Date.now() - start,
        // The timeout and a refused connection are different operator
        // problems, and the abort reason is the only thing that tells them
        // apart.
        detail:
          err instanceof Error && err.name === 'TimeoutError'
            ? `no response within ${String(this._config.timeoutMs)}ms`
            : 'connection failed',
      };
    }

    const latencyMs = Date.now() - start;
    const body = await response
      .json()
      .then((parsed: unknown) => parsed as ReadinessBody)
      .catch(() => null);

    if (body === null) {
      return {
        name: target.name,
        status: 'unreachable',
        latencyMs,
        detail: `unparseable response (HTTP ${String(response.status)})`,
      };
    }

    const detail = summarizeChecks(body);

    if (!response.ok) {
      // The service answered and said it is unhealthy. That is `fail`, not
      // `unreachable` — it is up, and it has told us why.
      return { name: target.name, status: 'fail', latencyMs, detail };
    }

    if (body.status === 'degraded') {
      return { name: target.name, status: 'degraded', latencyMs, detail };
    }

    if (body.status !== 'ok') {
      return {
        name: target.name,
        status: 'unreachable',
        latencyMs,
        detail: 'unrecognized readiness status',
      };
    }

    return { name: target.name, status: 'ok', latencyMs };
  }
}

/**
 * Flattens a readiness `checks` map into one line.
 *
 * The old rollup discarded this entirely, so a 503 from session-manager showed
 * as a colour with no cause — exactly the "wall of numbers" the plan's §6 says
 * a red state must never be.
 */
function summarizeChecks(body: ReadinessBody): string | undefined {
  const checks = body.checks;
  if (checks === undefined) return undefined;

  const parts = Object.entries(checks)
    .filter(([, value]) => typeof value === 'string')
    .map(([key, value]) => `${key}: ${String(value)}`);
  return parts.length > 0 ? parts.join('; ') : undefined;
}
