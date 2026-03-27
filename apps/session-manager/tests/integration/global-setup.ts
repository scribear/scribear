import { Kysely, PostgresDialect } from 'kysely';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import type { ProvidedContext } from 'vitest';

import { getMigrator } from '@scribear/scribear-db';

const DOCKERFILE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/scribear-db',
);

const DB_NAME = 'test';
const DB_USER = 'test';
const DB_PASSWORD = 'test';
const DB_PORT = 5432;

let container: StartedTestContainer;

export async function setup({
  provide,
}: {
  provide: <T extends keyof ProvidedContext>(
    key: T,
    value: ProvidedContext[T],
  ) => void;
}) {
  container = await GenericContainer.fromDockerfile(DOCKERFILE_DIR)
    .build()
    .then((image) =>
      image
        .withEnvironment({
          POSTGRES_DB: DB_NAME,
          POSTGRES_USER: DB_USER,
          POSTGRES_PASSWORD: DB_PASSWORD,
        })
        .withCommand([
          'postgres',
          '-c',
          'shared_preload_libraries=pg_cron',
          '-c',
          `cron.database_name=${DB_NAME}`,
        ])
        .withExposedPorts(DB_PORT)
        .withWaitStrategy(Wait.forHealthCheck())
        .start(),
    );

  const dbHost = container.getHost();
  const dbPort = container.getMappedPort(DB_PORT);

  const db = new Kysely<unknown>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        host: dbHost,
        port: dbPort,
        database: DB_NAME,
        user: DB_USER,
        password: DB_PASSWORD,
      }),
    }),
  });

  const { error } = await getMigrator(db).migrateToLatest();
  await db.destroy();

  if (error) {
    console.error(error);
    throw new Error('Failed to migrate', error);
  }

  provide('dbConfig', {
    dbHost,
    dbPort,
    dbName: DB_NAME,
    dbUser: DB_USER,
    dbPassword: DB_PASSWORD,
  });
}

export async function teardown() {
  await container.stop();
}
