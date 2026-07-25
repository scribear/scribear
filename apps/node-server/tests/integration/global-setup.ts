import { Kysely, PostgresDialect } from 'kysely';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from 'testcontainers';
import type { ProvidedContext } from 'vitest';

import { getMigrator } from '@scribear/scribear-db';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, '../../../..');
const DB_DOCKERFILE_DIR = path.join(REPO_ROOT, 'infra/scribear-db');
const SESSION_MANAGER_DOCKERFILE = 'apps/session-manager/Dockerfile';
const TRANSCRIPTION_SERVICE_CONTEXT = path.join(
  REPO_ROOT,
  'transcription_service',
);

const DB_NAME = 'test';
const DB_USER = 'test';
const DB_PASSWORD = 'test';
const DB_PORT = 5432;
const DB_NETWORK_ALIAS = 'postgres';

const SESSION_MANAGER_PORT = 80;

const TEST_ADMIN_API_KEY = 'test-admin-api-key';
const TEST_SERVICE_API_KEY = 'test-service-api-key';
const TEST_SESSION_TOKEN_SIGNING_KEY = 'test-session-token-signing-key';
const TEST_TRANSCRIPTION_API_KEY = 'test-transcription-api-key';

const TRANSCRIPTION_PORT = 80;

const REDIS_PORT = 6379;
const REDIS_PASSWORD = 'test';
const REDIS_NETWORK_ALIAS = 'redis';

/**
 * Identity the transcription service publishes its host snapshot under.
 * Fixed rather than left to default to the container's hostname, so a test
 * can address the key directly instead of scanning the index.
 */
const TRANSCRIPTION_HOST_ID = 'test-transcription-host';

let network: StartedNetwork | undefined;
let dbContainer: StartedTestContainer | undefined;
let sessionManagerContainer: StartedTestContainer | undefined;
let transcriptionContainer: StartedTestContainer | undefined;
let redisContainer: StartedTestContainer | undefined;

export async function setup({
  provide,
}: {
  provide: <T extends keyof ProvidedContext>(
    key: T,
    value: ProvidedContext[T],
  ) => void;
}) {
  network = await new Network().start();

  // 1. Build / start postgres + migrate.
  const dbImageEnv = process.env['SCRIBEAR_DB_IMAGE'];
  const dbImage =
    dbImageEnv != null
      ? new GenericContainer(dbImageEnv)
      : await GenericContainer.fromDockerfile(DB_DOCKERFILE_DIR)
          .withCache(true)
          .build();

  dbContainer = await dbImage
    .withEnvironment({
      POSTGRES_DB: DB_NAME,
      POSTGRES_USER: DB_USER,
      POSTGRES_PASSWORD: DB_PASSWORD,
    })
    .withExposedPorts(DB_PORT)
    .withNetwork(network)
    .withNetworkAliases(DB_NETWORK_ALIAS)
    .withWaitStrategy(Wait.forHealthCheck())
    .start();

  const dbHost = dbContainer.getHost();
  const dbPort = dbContainer.getMappedPort(DB_PORT);

  const migrationKysely = new Kysely<unknown>({
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
  const { error: migrationError } =
    await getMigrator(migrationKysely).migrateToLatest();
  await migrationKysely.destroy();
  if (migrationError) {
    console.error(migrationError);
    throw new Error('Failed to migrate test database', {
      cause: migrationError,
    });
  }

  // 2. Build / start the Session Manager container against the migrated DB.
  const sessionManagerImageEnv = process.env['SCRIBEAR_SESSION_MANAGER_IMAGE'];
  const sessionManagerImage =
    sessionManagerImageEnv != null
      ? new GenericContainer(sessionManagerImageEnv)
      : await GenericContainer.fromDockerfile(
          REPO_ROOT,
          SESSION_MANAGER_DOCKERFILE,
        )
          .withCache(true)
          .build();

  sessionManagerContainer = await sessionManagerImage
    .withEnvironment({
      LOG_LEVEL: 'silent',
      HOST: '0.0.0.0',
      PORT: String(SESSION_MANAGER_PORT),
      ADMIN_API_KEY: TEST_ADMIN_API_KEY,
      SESSION_MANAGER_SERVICE_API_KEY: TEST_SERVICE_API_KEY,
      SESSION_TOKEN_SIGNING_KEY: TEST_SESSION_TOKEN_SIGNING_KEY,
      DB_HOST: DB_NETWORK_ALIAS,
      DB_PORT: String(DB_PORT),
      DB_NAME,
      DB_USER,
      DB_PASSWORD,
    })
    .withExposedPorts(SESSION_MANAGER_PORT)
    .withNetwork(network)
    .withWaitStrategy(Wait.forHealthCheck())
    .start();

  const sessionManagerHost = sessionManagerContainer.getHost();
  const sessionManagerMappedPort =
    sessionManagerContainer.getMappedPort(SESSION_MANAGER_PORT);
  const sessionManagerBaseUrl = `http://${sessionManagerHost}:${sessionManagerMappedPort.toString()}`;

  // 3. Start Redis for the telemetry backplane (B1.7). The stock image, not
  // `infra/scribear-redis`'s: that image is the deployment's redis-server plus
  // a healthcheck, and building it here would test the Dockerfile rather than
  // the publisher.
  //
  // On the shared network, and started before the transcription service,
  // because that container publishes into it: the two need a name they can
  // both resolve, and the mapped host port only exists on the host side.
  redisContainer = await new GenericContainer('redis:8-alpine')
    .withCommand(['redis-server', '--requirepass', REDIS_PASSWORD])
    .withExposedPorts(REDIS_PORT)
    .withNetwork(network)
    .withNetworkAliases(REDIS_NETWORK_ALIAS)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();

  const redisUrl = `redis://:${REDIS_PASSWORD}@${redisContainer.getHost()}:${String(
    redisContainer.getMappedPort(REDIS_PORT),
  )}`;
  // The same server addressed from inside the network. Not interchangeable
  // with `redisUrl`, which is only routable from the host.
  const inNetworkRedisUrl = `redis://:${REDIS_PASSWORD}@${REDIS_NETWORK_ALIAS}:${String(REDIS_PORT)}`;

  // 4. Build / start the transcription service (CPU image).
  const txImageEnv = process.env['SCRIBEAR_TRANSCRIPTION_SERVICE_IMAGE'];
  const txImage =
    txImageEnv != null
      ? new GenericContainer(txImageEnv)
      : await GenericContainer.fromDockerfile(
          TRANSCRIPTION_SERVICE_CONTEXT,
          'Dockerfile_CPU',
        )
          .withCache(true)
          .build();

  // Minimal provider config for the test: just the debug provider at the
  // 48000Hz sample rate of the bundled `mono_f64le.wav` test fixture, no
  // whisper / silero contexts, so the container boots without GPU deps even
  // on the CPU image.
  const providerConfigJson = JSON.stringify({
    num_workers: 1,
    contexts: [],
    providers: {
      debug: {
        provider_uid: 'debug',
        provider_config: { sample_rate: 48000, num_channels: 1 },
      },
    },
  });

  transcriptionContainer = await txImage
    .withEnvironment({
      LOG_LEVEL: 'fatal',
      HOST: '0.0.0.0',
      PORT: String(TRANSCRIPTION_PORT),
      API_KEY: TEST_TRANSCRIPTION_API_KEY,
      WS_INIT_TIMEOUT_SEC: '10',
      PROVIDER_CONFIG_PATH: '/app/provider_config.json',
      // Turns on this host's own telemetry publisher, so its
      // `/providers/health` body lands in the same Redis the fleet view reads.
      // Without these two it publishes nothing at all and the suite has no
      // Python-produced payload to check the TypeScript mirror against.
      REDIS_URL: inNetworkRedisUrl,
      TRANSCRIPTION_HOST_ID,
    })
    .withCopyContentToContainer([
      {
        content: providerConfigJson,
        target: '/app/provider_config.json',
      },
    ])
    .withExposedPorts(TRANSCRIPTION_PORT)
    .withNetwork(network)
    .withWaitStrategy(
      Wait.forHttp('/probes/liveness', TRANSCRIPTION_PORT).withStartupTimeout(
        180_000,
      ),
    )
    .start();

  const transcriptionHost = transcriptionContainer.getHost();
  const transcriptionPort =
    transcriptionContainer.getMappedPort(TRANSCRIPTION_PORT);
  const transcriptionServiceBaseUrl = `http://${transcriptionHost}:${transcriptionPort.toString()}`;

  provide('redisUrl', redisUrl);
  provide('transcriptionHostId', TRANSCRIPTION_HOST_ID);
  provide('sessionManagerBaseUrl', sessionManagerBaseUrl);
  provide('transcriptionServiceBaseUrl', transcriptionServiceBaseUrl);
  provide('adminApiKey', TEST_ADMIN_API_KEY);
  provide('serviceApiKey', TEST_SERVICE_API_KEY);
  provide('sessionTokenSigningKey', TEST_SESSION_TOKEN_SIGNING_KEY);
  provide('transcriptionApiKey', TEST_TRANSCRIPTION_API_KEY);
}

export async function teardown() {
  if (redisContainer !== undefined) {
    await redisContainer.stop();
  }
  if (transcriptionContainer !== undefined) {
    await transcriptionContainer.stop();
  }
  if (sessionManagerContainer !== undefined) {
    await sessionManagerContainer.stop();
  }
  if (dbContainer !== undefined) {
    await dbContainer.stop();
  }
  if (network !== undefined) {
    await network.stop();
  }
}
