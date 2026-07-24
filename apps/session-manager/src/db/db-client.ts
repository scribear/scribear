import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import { type DB, readSchemaState } from '@scribear/scribear-db';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

export interface DBClientConfig {
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
}

export class DBClient {
  private _db: Kysely<DB>;
  private _schemaIsCurrent = false;

  get db() {
    return this._db;
  }

  /**
   * Migrations this build ships that the database has not applied. Empty means
   * the schema is new enough to serve.
   *
   * Read by the readiness probe, so it is called every few seconds by the
   * container healthcheck, the monitoring sidecar and the admin health rollup.
   * The answer is cached once it is empty: a database cannot lose migrations
   * while this process runs, so steady state costs nothing. It is *not* cached
   * while there are pending migrations, which is what lets a deployment go ready
   * as soon as the migrator has run, without restarting this service.
   *
   * A schema *ahead* of this build is not reported here at all — see
   * `SchemaState.unknown`. That is a rollback, and this build's queries still
   * work.
   */
  async pendingMigrations(): Promise<readonly string[]> {
    if (this._schemaIsCurrent) return [];

    const state = await readSchemaState(this._db);
    if (state.upToDate) {
      this._schemaIsCurrent = true;
      return [];
    }
    return state.pending;
  }

  constructor(
    logger: AppDependencies['logger'],
    dbClientConfig: AppDependencies['dbClientConfig'],
  ) {
    this._db = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          host: dbClientConfig.dbHost,
          port: dbClientConfig.dbPort,
          database: dbClientConfig.dbName,
          user: dbClientConfig.dbUser,
          password: dbClientConfig.dbPassword,
        }),
      }),
      log: (event) => {
        if (event.level === 'query') {
          logger.debug(
            {
              sql: event.query.sql,
              params: event.query.parameters,
              durationMs: event.queryDurationMillis,
            },
            'Database query',
          );
        } else {
          logger.error({ sql: event.query.sql }, 'Database query error');
        }
      },
    });
  }

  /**
   * Destroy the database connection pool. Call on shutdown.
   */
  async destroy() {
    await this._db.destroy();
  }
}
