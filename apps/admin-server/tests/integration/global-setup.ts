import {
  GenericContainer,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import type { ProvidedContext } from 'vitest';

const DB_NAME = 'admin_test';
const DB_USER = 'admin_test';
const DB_PASSWORD = 'admin_test';
const DB_PORT = 5432;

const REDIS_PORT = 6379;
const REDIS_PASSWORD = 'test';

let dbContainer: StartedTestContainer;
let redisContainer: StartedTestContainer;

/**
 * Spins a plain Postgres for the admin BFF integration tests. The BFF applies
 * its own `admin_audit_log` migration on server `onReady`, so nothing needs to
 * be migrated here. A modern Postgres provides `gen_random_uuid()` built-in.
 *
 * Also spins a stock Redis for the fleet telemetry backplane (B1.7 §2.5) —
 * the stock image, not `infra/scribear-redis`'s: that image is the
 * deployment's redis-server plus a healthcheck, and building it here would
 * test the Dockerfile rather than `/fleet`. Matches node-server's
 * integration setup, which caught the same class of connection-timing bug
 * a fake client cannot.
 */
export async function setup({
  provide,
}: {
  provide: <T extends keyof ProvidedContext>(
    key: T,
    value: ProvidedContext[T],
  ) => void;
}) {
  dbContainer = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({
      POSTGRES_DB: DB_NAME,
      POSTGRES_USER: DB_USER,
      POSTGRES_PASSWORD: DB_PASSWORD,
    })
    .withExposedPorts(DB_PORT)
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2),
    )
    .start();

  provide('dbConfig', {
    dbHost: dbContainer.getHost(),
    dbPort: dbContainer.getMappedPort(DB_PORT),
    dbName: DB_NAME,
    dbUser: DB_USER,
    dbPassword: DB_PASSWORD,
  });

  redisContainer = await new GenericContainer('redis:8-alpine')
    .withCommand(['redis-server', '--requirepass', REDIS_PASSWORD])
    .withExposedPorts(REDIS_PORT)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();

  provide(
    'redisUrl',
    `redis://:${REDIS_PASSWORD}@${redisContainer.getHost()}:${String(
      redisContainer.getMappedPort(REDIS_PORT),
    )}`,
  );
}

export async function teardown() {
  await dbContainer.stop();
  await redisContainer.stop();
}
