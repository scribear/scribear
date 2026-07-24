import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import { readSchemaState } from '@scribear/scribear-db';
import { SCHEMA_STATUS_SCHEMA } from '@scribear/session-manager-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

/**
 * Reports the database schema this build expects against what the database has
 * applied.
 *
 * The point of asking *this* service rather than reading the migration table
 * directly is that the answer combines two facts only this container holds
 * together: the schema its code was compiled against, and the database it is
 * actually pointed at. admin-server's Config Check compares that against its own
 * build to catch a deployment where the services do not agree on a version.
 *
 * Reads state fresh on every call rather than using `DBClient.pendingMigrations`,
 * whose cached answer exists for the readiness hot path — an operator asking this
 * question wants the current truth, including the `unknown` list that readiness
 * deliberately ignores.
 */
export class DatabaseController {
  private _dbClient: AppDependencies['dbClient'];

  constructor(dbClient: AppDependencies['dbClient']) {
    this._dbClient = dbClient;
  }

  async schemaStatus(
    _req: BaseFastifyRequest<typeof SCHEMA_STATUS_SCHEMA>,
    res: BaseFastifyReply<typeof SCHEMA_STATUS_SCHEMA>,
  ) {
    const state = await readSchemaState(this._dbClient.db);

    res.code(200).send({
      initialized: state.initialized,
      applied: [...state.applied],
      expected: [...state.expected],
      pending: [...state.pending],
      unknown: [...state.unknown],
      upToDate: state.upToDate,
      latestApplied: state.latestApplied,
      latestExpected: state.latestExpected,
    });
  }
}
