import { Type } from 'typebox';
import type { Static } from 'typebox';
import { Value } from 'typebox/value';

/**
 * Mirrors `AlertSeverity` in
 * `apps/monitoring-sidecar/src/server/shared/alerts/alert-rules.ts`. The
 * sidecar has only two — every rule fires only when something is actually
 * wrong, so there is no `info` tier to mirror: the absence of any alert *is*
 * the console's "info/healthy" state (PLAN-VisibleErrors §4.3, §10).
 */
export type MonitoringAlertSeverity = 'critical' | 'warning';

/**
 * One firing alert, as read from the monitoring sidecar's
 * `GET /api/monitoring/v1/alerts`. Restated here rather than imported — the
 * sidecar has no schema package other services depend on (the same reasoning
 * `config-check.service.ts`'s `CONFIG_AUDIT_RESPONSE_SCHEMA` already gives for
 * `/config-audit`) — and validated at the boundary with `Value.Check` for the
 * same reason: this body crosses a version boundary, and every field below is
 * dereferenced unconditionally by the console.
 */
export interface MonitoringAlert {
  id: string;
  failureModes: string[];
  severity: MonitoringAlertSeverity;
  summary: string;
  likelyCause: string;
  stage: string;
  value: number;
  threshold: number;
}

const MONITORING_ALERT_SCHEMA = Type.Object({
  id: Type.String(),
  failureModes: Type.Array(Type.String()),
  severity: Type.Union([Type.Literal('critical'), Type.Literal('warning')]),
  summary: Type.String(),
  likelyCause: Type.String(),
  stage: Type.String(),
  value: Type.Number(),
  threshold: Type.Number(),
});

const ALERTS_RESPONSE_SCHEMA = Type.Object({
  alerts: Type.Array(MONITORING_ALERT_SCHEMA),
});

type AlertsResponse = Static<typeof ALERTS_RESPONSE_SCHEMA>;

export interface AlertsConfig {
  /**
   * Base URL of the monitoring sidecar, reached only over the backend
   * network. Never empty in practice — the sidecar is a core service with no
   * compose profile — same value `ConfigCheckConfig.monitoringSidecarBaseUrl`
   * already reads for `/config-audit`.
   */
  monitoringSidecarBaseUrl: string;
  /** Shared with Config Check's `upstreamTimeoutMs`: an operator is waiting on this page too. */
  upstreamTimeoutMs: number;
}

/**
 * Thrown by `AlertsService.list()` for any reason the sidecar's answer could
 * not be trusted — unreachable, a non-2xx status, an unparseable body, or a
 * body shape this build does not recognize. Kept as one error rather than one
 * per cause: the controller's action for all of them is the same, report
 * "could not ask" rather than silently rendering an empty (and therefore
 * healthy-looking) list.
 */
export class AlertsUnavailableError extends Error {}

/**
 * Reads the monitoring sidecar's currently-firing alerts and hands them to
 * the admin console (PLAN-VisibleErrors §4.3 — "the operator-facing console
 * never asks the one service that already knows whether captions are working
 * right now").
 *
 * No API key on this call: the sidecar's own routes carry none (unlike
 * node-server's `/status`, which requires the shared service key) — reached
 * only over the backend network, the same trust boundary
 * `_checkSecretPlaceholders` already relies on one hop over for
 * `/config-audit`. Routing through the sidecar rather than evaluating rules
 * here is deliberate: it is already the mediator for cross-service facts and
 * already holds every key this would need, so admin-server needs none of its
 * own.
 */
export class AlertsService {
  private _config: AlertsConfig;

  constructor(alertsConfig: AlertsConfig) {
    this._config = alertsConfig;
  }

  /**
   * Never resolves to an empty list for a call that failed — that would be
   * indistinguishable from "nothing is currently firing", which is exactly
   * the distinction this route exists to preserve. Every failure path throws
   * {@link AlertsUnavailableError} instead.
   */
  async list(): Promise<MonitoringAlert[]> {
    let response: Response;
    try {
      response = await fetch(
        `${this._config.monitoringSidecarBaseUrl}/api/monitoring/v1/alerts`,
        { signal: AbortSignal.timeout(this._config.upstreamTimeoutMs) },
      );
    } catch {
      throw new AlertsUnavailableError(
        `monitoring-sidecar's /api/monitoring/v1/alerts did not answer within ${String(this._config.upstreamTimeoutMs)}ms.`,
      );
    }

    if (!response.ok) {
      throw new AlertsUnavailableError(
        `monitoring-sidecar's /api/monitoring/v1/alerts answered HTTP ${String(response.status)}.`,
      );
    }

    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new AlertsUnavailableError(
        "monitoring-sidecar's /api/monitoring/v1/alerts answered with a body Alerts could not parse.",
      );
    }

    // `Value.Check` over the whole body, not a narrower per-field guard: every
    // field is dereferenced unconditionally downstream, so a partial match (an
    // alert missing `likelyCause`, say) must fail the same way a malformed
    // body does rather than reach the console as `undefined`.
    if (!Value.Check(ALERTS_RESPONSE_SCHEMA, parsed)) {
      throw new AlertsUnavailableError(
        "monitoring-sidecar's /api/monitoring/v1/alerts answered with a body Alerts does not recognize — the sidecar may be a different version than admin-server.",
      );
    }

    const body: AlertsResponse = parsed;
    return body.alerts;
  }
}
