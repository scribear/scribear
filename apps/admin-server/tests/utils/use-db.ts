import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, inject } from 'vitest';

import type { AdminDB } from '#src/db/admin-db.types.js';

interface DbCtx {
  db: Kysely<AdminDB>;
}

/**
 * Kysely client against the test postgres for asserting audit rows. Truncates
 * `admin_audit_log` after each test. Register AFTER `useServer()` so the table
 * (created by the server's onReady migration) already exists.
 */
export function useDb(): DbCtx {
  const ctx: DbCtx = { db: null as unknown as Kysely<AdminDB> };

  beforeAll(() => {
    const cfg = inject('dbConfig');
    ctx.db = new Kysely<AdminDB>({
      dialect: new PostgresDialect({
        pool: new pg.Pool({
          host: cfg.dbHost,
          port: cfg.dbPort,
          database: cfg.dbName,
          user: cfg.dbUser,
          password: cfg.dbPassword,
        }),
      }),
    });
  });

  afterEach(async () => {
    await sql`TRUNCATE admin_audit_log`.execute(ctx.db);
  });

  afterAll(async () => {
    await ctx.db.destroy();
  });

  return ctx;
}
