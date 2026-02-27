import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { DB } from '@scribear/scribear-db';

import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';

export interface DBClientConfig {
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
}

export class DBClient {
  private _db: Kysely<DB>;

  get db() {
    return this._db;
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
        } else if (event.level === 'error') {
          logger.error({ sql: event.query.sql }, 'Database query error');
        }
      },
    });
  }

  /**
   * Destroy the database connection pool
   * Should be called when shutting down the application
   */
  async destroy() {
    await this._db.destroy();
  }
}
