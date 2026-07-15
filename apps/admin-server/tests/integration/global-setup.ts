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

let dbContainer: StartedTestContainer;

/**
 * Spins a plain Postgres for the admin BFF integration tests. The BFF applies
 * its own `admin_audit_log` migration on server `onReady`, so nothing needs to
 * be migrated here. A modern Postgres provides `gen_random_uuid()` built-in.
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
}

export async function teardown() {
  await dbContainer.stop();
}
