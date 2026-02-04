import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { DB } from '@scribear/scribear-db';

import type { AppDependencies } from '@/server/dependency-injection/register-dependencies.js';

import type AppConfig from '../app-config/app-config.js';

class DBClient {
  private _db: Kysely<DB>;

  get db() {
    return this._db;
  }

  constructor(config: AppDependencies['config']) {
    this._db = new Kysely<DB>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          host: config.dbHost,
          port: config.dbPort,
          database: config.dbName,
          user: config.dbUser,
          password: config.dbPassword,
        }),
      }),
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

export default DBClient;
