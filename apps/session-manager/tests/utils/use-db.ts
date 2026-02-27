import { type Kysely } from 'kysely';
import { afterAll, afterEach, beforeAll, inject } from 'vitest';

import type { DB } from '@scribear/scribear-db';

import { DBClient } from '#src/db/db-client.js';

import { createMockLogger } from './mock-logger.js';

export function useDb(tablesToTruncate: (keyof DB)[] = []): {
  db: Kysely<DB>;
  dbClient: DBClient;
} {
  const ctx = {
    db: null as unknown as Kysely<DB>,
    dbClient: null as unknown as DBClient,
  };

  beforeAll(() => {
    ctx.dbClient = new DBClient(
      createMockLogger() as never,
      inject('dbConfig'),
    );
    ctx.db = ctx.dbClient.db;
  });

  afterEach(async () => {
    for (const table of tablesToTruncate) {
      await ctx.db.deleteFrom(table).execute();
    }
  });

  afterAll(async () => {
    await ctx.dbClient.destroy();
  });

  return ctx;
}
