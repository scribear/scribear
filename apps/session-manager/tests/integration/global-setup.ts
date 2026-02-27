import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { ProvidedContext } from 'vitest';

import { getMigrator } from '@scribear/scribear-db';

let container: StartedPostgreSqlContainer;

export async function setup({
  provide,
}: {
  provide: <T extends keyof ProvidedContext>(
    key: T,
    value: ProvidedContext[T],
  ) => void;
}) {
  container = await new PostgreSqlContainer('postgres:18.1-alpine3.23').start();

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        host: container.getHost(),
        port: container.getPort(),
        database: container.getDatabase(),
        user: container.getUsername(),
        password: container.getPassword(),
      }),
    }),
  });

  const { error } = await getMigrator(db).migrateToLatest();
  await db.destroy();

  if (error) {
    console.error('Failed to migrate');
    console.error(error);
    throw error;
  }

  provide('dbConfig', {
    dbHost: container.getHost(),
    dbPort: container.getPort(),
    dbName: container.getDatabase(),
    dbUser: container.getUsername(),
    dbPassword: container.getPassword(),
  });
}

export async function teardown() {
  await container?.stop();
}
