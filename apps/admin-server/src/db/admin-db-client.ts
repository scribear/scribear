import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

import type { AdminDB } from './admin-db.types.js';
import { getAdminMigrator } from './get-admin-migrator.js';

export interface AdminDbClientConfig {
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
}

export class AdminDbClient {
  private _db: Kysely<AdminDB>;
  private _logger: AppDependencies['logger'];

  get db() {
    return this._db;
  }

  constructor(
    logger: AppDependencies['logger'],
    dbClientConfig: AppDependencies['dbClientConfig'],
  ) {
    this._logger = logger;
    this._db = new Kysely<AdminDB>({
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
   * Apply admin-server's own migrations (currently just the audit-log table).
   * Idempotent and lock-safe across instances. Throws if any migration fails.
   */
  async migrateToLatest() {
    const migrator = getAdminMigrator(this._db as unknown as Kysely<unknown>);
    const { error, results } = await migrator.migrateToLatest();

    for (const result of results ?? []) {
      if (result.status === 'Success') {
        this._logger.info(
          { migration: result.migrationName },
          'Applied admin migration',
        );
      } else if (result.status === 'Error') {
        this._logger.error(
          { migration: result.migrationName },
          'Failed to apply admin migration',
        );
      }
    }

    if (error) {
      throw error instanceof Error
        ? error
        : new Error('Admin database migration failed', { cause: error });
    }
  }

  /**
   * Destroy the database connection pool. Call on shutdown.
   */
  async destroy() {
    await this._db.destroy();
  }
}
