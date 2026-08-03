import { sql } from 'kysely';

import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

import { READINESS_SCHEMA } from './probes.schema.js';

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
      await sql`SELECT 1`.execute(this._dbClient.db);
      res.code(200).send({ status: 'ok' });
    } catch {
      res.code(503).send({ status: 'fail', checks: { database: 'fail' } });
    }
  }
}
