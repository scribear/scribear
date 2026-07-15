import { sql } from 'kysely';

import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { okEnvelope } from '#src/server/shared/envelope/envelope.js';

type ComponentStatus = 'ok' | 'degraded' | 'unreachable' | 'fail';

export class HealthController {
  private _dbClient: AppDependencies['dbClient'];
  private _sessionManagerGatewayService: AppDependencies['sessionManagerGatewayService'];

  constructor(
    dbClient: AppDependencies['dbClient'],
    sessionManagerGatewayService: AppDependencies['sessionManagerGatewayService'],
  ) {
    this._dbClient = dbClient;
    this._sessionManagerGatewayService = sessionManagerGatewayService;
  }

  /**
   * Rollup of the pieces the admin console depends on. Requires a session — it
   * exposes infrastructure state. (Container/orchestration probes use the
   * unauthenticated `/probes/*` routes instead.)
   */
  async health(_req: BaseFastifyRequest, res: BaseFastifyReply) {
    let database: ComponentStatus = 'ok';
    try {
      await sql`SELECT 1`.execute(this._dbClient.db);
    } catch {
      database = 'fail';
    }

    let sessionManager: ComponentStatus = 'ok';
    const start = Date.now();
    const [readinessResponse, readinessError] =
      await this._sessionManagerGatewayService.readiness();
    const sessionManagerLatencyMs = Date.now() - start;
    if (readinessError) {
      sessionManager = 'unreachable';
    } else if (readinessResponse.status !== 200) {
      sessionManager = 'degraded';
    }

    res.code(200).send(
      okEnvelope({
        bff: 'ok' as const,
        database,
        sessionManager,
        sessionManagerLatencyMs,
        checkedAt: new Date().toISOString(),
      }),
    );
  }
}
