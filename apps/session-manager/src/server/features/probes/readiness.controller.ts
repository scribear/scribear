import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import { READINESS_SCHEMA } from '@scribear/session-manager-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

export class ReadinessController {
  private _dbClient: AppDependencies['dbClient'];
  private _logger: AppDependencies['logger'];

  constructor(
    dbClient: AppDependencies['dbClient'],
    logger: AppDependencies['logger'],
  ) {
    this._dbClient = dbClient;
    this._logger = logger;
  }

  /**
   * Two questions, reported separately: can this service reach the database, and
   * is the applied schema at least as new as the one this build was written
   * against?
   *
   * The schema half is here because a deployment whose migrations never ran used
   * to present as assorted 500s from whichever route first touched a missing
   * column, with a green readiness probe throughout. That is the most common
   * deployment mistake in this stack and the cheapest one to state plainly — and
   * stating it here is what puts it in the admin console's health rollup and the
   * monitoring sidecar's probe metrics for free, since both read this `checks`
   * map generically.
   */
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
    } catch {
      // Unreachable. The schema question cannot be answered against a database
      // that will not answer, so it is reported as failed too rather than
      // guessed at.
      res
        .code(503)
        .send({ status: 'fail', checks: { database: 'fail', schema: 'fail' } });
      return;
    }

    const pending = await this._dbClient.pendingMigrations();
    if (pending.length > 0) {
      this._logger.error(
        { pending },
        'Database schema is behind this build; failing readiness. Run the migrations - see deployment/run-migrator.sh',
      );
      res
        .code(503)
        .send({ status: 'fail', checks: { database: 'ok', schema: 'fail' } });
      return;
    }

    res.code(200).send({ status: 'ok' });
  }
}
