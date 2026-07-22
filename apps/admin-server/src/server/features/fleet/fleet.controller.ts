import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import {
  errorEnvelope,
  okEnvelope,
} from '#src/server/shared/envelope/envelope.js';

export class FleetController {
  private _telemetry: AppDependencies['fleetTelemetryService'];
  private _logger: AppDependencies['logger'];

  constructor(
    fleetTelemetryService: AppDependencies['fleetTelemetryService'],
    logger: AppDependencies['logger'],
  ) {
    this._telemetry = fleetTelemetryService;
    this._logger = logger;
  }

  /**
   * Snapshot of every live room, node-server instance and provider across the
   * fleet, read entirely from Redis (B1.7 §2.5) — no fan-out to instances.
   *
   * 503, not 200-with-empty-data: unlike `/health` (which always speaks for
   * itself), an empty result here is indistinguishable from "nothing is
   * running" unless the caller can tell "telemetry is unavailable" apart from
   * "the fleet is genuinely idle."
   */
  async fleet(req: BaseFastifyRequest, res: BaseFastifyReply) {
    if (!this._telemetry.enabled) {
      return res
        .code(503)
        .send(
          errorEnvelope(
            'TELEMETRY_UNAVAILABLE',
            'Live fleet telemetry is not configured (REDIS_URL unset).',
            req.id,
          ),
        );
    }

    try {
      const snapshot = await this._telemetry.snapshot();
      return await res.code(200).send(okEnvelope(snapshot));
    } catch (err) {
      this._logger.warn({ err }, 'fleet snapshot failed');
      return res
        .code(503)
        .send(
          errorEnvelope(
            'TELEMETRY_DEGRADED',
            'Could not read live fleet telemetry.',
            req.id,
          ),
        );
    }
  }
}
