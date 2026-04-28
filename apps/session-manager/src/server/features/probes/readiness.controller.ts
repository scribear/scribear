import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import { READINESS_SCHEMA } from '@scribear/session-manager-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

export class ReadinessController {
  private _dbClient: AppDependencies['dbClient'];

  constructor(dbClient: AppDependencies['dbClient']) {
    this._dbClient = dbClient;
  }

  async readiness(
    _req: BaseFastifyRequest<typeof READINESS_SCHEMA>,
    res: BaseFastifyReply<typeof READINESS_SCHEMA>,
  ) {
    try {
      await this._dbClient.db
        .selectFrom('devices')
        .select('uid')
        .limit(1)
        .execute();
      res.code(200).send({ status: 'ok' });
    } catch {
      res.code(503).send({ status: 'fail', checks: { database: 'fail' } });
    }
  }
}
