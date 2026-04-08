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

const DB_DOCKERFILE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/scribear-db',
);
const REDIS_DOCKERFILE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../infra/scribear-redis',
);

const DB_NAME = 'test';
const DB_USER = 'test';
const DB_PASSWORD = 'test';
const DB_PORT = 5432;
const REDIS_PORT = 6379;
const REDIS_PASSWORD = 'test';

let dbContainer: StartedTestContainer;
let redisContainer: StartedTestContainer;

export async function setup({
  provide,
}: {
  provide: <T extends keyof ProvidedContext>(
    key: T,
    value: ProvidedContext[T],
  ) => void;
}) {
  const prebuiltDBImage = process.env['SCRIBEAR_DB_IMAGE'];
  const dbImage =
    prebuiltDBImage != null
      ? new GenericContainer(prebuiltDBImage)
      : await GenericContainer.fromDockerfile(DB_DOCKERFILE_DIR)
          .withCache(true)
          .build();

  const prebuiltRedisImage = process.env['SCRIBEAR_REDIS_IMAGE'];
  const redisImage =
    prebuiltRedisImage != null
      ? new GenericContainer(prebuiltRedisImage)
      : await GenericContainer.fromDockerfile(REDIS_DOCKERFILE_DIR)
          .withCache(true)
          .build();

  const [dbStarted, redisStarted] = await Promise.all([
    dbImage
      .withEnvironment({
        POSTGRES_DB: DB_NAME,
        POSTGRES_USER: DB_USER,
        POSTGRES_PASSWORD: DB_PASSWORD,
      })
      .withExposedPorts(DB_PORT)
      .withWaitStrategy(Wait.forHealthCheck())
      .start(),
    redisImage
      .withEnvironment({ REDIS_PASSWORD })
      .withCommand(['redis-server', '--requirepass', REDIS_PASSWORD])
      .withExposedPorts(REDIS_PORT)
      .withWaitStrategy(Wait.forHealthCheck())
      .start(),
  ]);

  dbContainer = dbStarted;
  redisContainer = redisStarted;

  const dbHost = dbContainer.getHost();
  const dbPort = dbContainer.getMappedPort(DB_PORT);

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

  const redisHost = redisContainer.getHost();
  const redisPort = redisContainer.getMappedPort(REDIS_PORT);

  provide('dbConfig', {
    dbHost,
    dbPort,
    dbName: DB_NAME,
    dbUser: DB_USER,
    dbPassword: DB_PASSWORD,
  });

  provide(
    'redisUrl',
    `redis://:${REDIS_PASSWORD}@${redisHost}:${String(redisPort)}`,
  );
}

export async function teardown() {
  await Promise.all([dbContainer.stop(), redisContainer.stop()]);
}
