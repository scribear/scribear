import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import {
  errorEnvelope,
  okEnvelope,
} from '#src/server/shared/envelope/envelope.js';

import { AlertsUnavailableError } from './alerts.service.js';

export class AlertsController {
  private _alerts: AppDependencies['alertsService'];

  constructor(alertsService: AppDependencies['alertsService']) {
    this._alerts = alertsService;
  }

  /**
   * The monitoring sidecar's currently-firing alerts (PLAN-VisibleErrors
   * §4.3), for the operator dashboard.
   *
   * 503, not 200-with-an-empty-list: matching `FleetController.fleet`'s own
   * reasoning, an empty list here is indistinguishable from "nothing is
   * firing" unless a caller reaching the sidecar can be told apart from one
   * that could not — which is the entire point of surfacing this at all. A
   * fetch failure must never render as a quiet, healthy-looking dashboard.
   */
  async alerts(req: BaseFastifyRequest, res: BaseFastifyReply) {
    try {
      const alerts = await this._alerts.list();
      return await res.code(200).send(
        okEnvelope({
          alerts,
          generatedAt: new Date().toISOString(),
        }),
      );
    } catch (err) {
      const message =
        err instanceof AlertsUnavailableError
          ? err.message
          : 'Could not read monitoring-sidecar alerts.';
      return res
        .code(503)
        .send(errorEnvelope('ALERTS_UNAVAILABLE', message, req.id));
    }
  }
}
