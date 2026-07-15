import { afterAll, beforeAll, inject } from 'vitest';

import { LogLevel } from '@scribear/base-fastify-server';

import type { AppConfig, BaseConfig } from '#src/app-config/app-config.js';
import type { DBClientConfig } from '#src/db/db-client.js';
import createServer from '#src/server/create-server.js';
import type { MaterializationWorkerConfig } from '#src/server/features/schedule-management/materialization.worker.js';
import type { AdminAuthConfig } from '#src/server/shared/services/admin-auth.service.js';
import type { ServiceAuthConfig } from '#src/server/shared/services/service-auth.service.js';
import type { SessionTokenConfig } from '#src/server/shared/services/session-token.service.js';

export const TEST_ADMIN_KEY = 'test-admin-key';
export const ADMIN_HEADER = `Bearer ${TEST_ADMIN_KEY}`;
export const TEST_SERVICE_KEY = 'test-service-key';
export const SERVICE_HEADER = `Bearer ${TEST_SERVICE_KEY}`;
export const TEST_SESSION_TOKEN_SIGNING_KEY = 'test-session-token-signing-key';

interface ServerCtx {
  fastify: Awaited<ReturnType<typeof createServer>>['fastify'];
}

/**
 * Per-section overrides accepted by `buildTestAppConfig` / `useServer`. Each
 * field is shallow-merged on top of the corresponding default block, so tests
 * only need to specify what they want to change.
 */
export interface TestAppConfigOverrides {
  baseConfig?: Partial<BaseConfig>;
  adminAuthConfig?: Partial<AdminAuthConfig>;
  serviceAuthConfig?: Partial<ServiceAuthConfig>;
  sessionTokenConfig?: Partial<SessionTokenConfig>;
  dbClientConfig?: Partial<DBClientConfig>;
  materializationWorkerConfig?: Partial<MaterializationWorkerConfig>;
}

/**
 * Builds an `AppConfig` for integration tests, wired to the postgres
 * container started by `tests/integration/global-setup.ts`. Tests pass
 * `overrides` to flip only the fields they care about (e.g.
 * `{ baseConfig: { isDevelopment: false } }`) without having to repeat the
 * rest of the config.
 *
 * Must be called inside a vitest hook (`beforeAll`, `it`, ...), because
 * `inject` is only valid in those contexts.
 */
export function buildTestAppConfig(
  overrides: TestAppConfigOverrides = {},
): AppConfig {
  const dbConfig = inject('dbConfig');

  return {
    baseConfig: {
      isDevelopment: true,
      logLevel: LogLevel.SILENT,
      port: 0,
      host: '127.0.0.1',
      ...overrides.baseConfig,
    },
    adminAuthConfig: {
      adminApiKey: TEST_ADMIN_KEY,
      ...overrides.adminAuthConfig,
    },
    serviceAuthConfig: {
      serviceApiKey: TEST_SERVICE_KEY,
      ...overrides.serviceAuthConfig,
    },
    sessionTokenConfig: {
      signingKey: TEST_SESSION_TOKEN_SIGNING_KEY,
      ...overrides.sessionTokenConfig,
    },
    dbClientConfig: { ...dbConfig, ...overrides.dbClientConfig },
    materializationWorkerConfig: {
      enabled: false,
      intervalMs: 60_000,
      staleAfterMs: 24 * 60 * 60 * 1000,
      maxRoomsPerTick: 1000,
      ...overrides.materializationWorkerConfig,
    },
  } as unknown as AppConfig;
}

/**
 * Boots an in-process Session Manager for integration tests, wired to the
 * postgres container spun up by `tests/integration/global-setup.ts`.
 *
 * `overrides` are forwarded to `buildTestAppConfig` so suites can spin up the
 * server with non-default config (e.g. `{ baseConfig: { isDevelopment: false } }`).
 */
export function useServer(overrides: TestAppConfigOverrides = {}): ServerCtx {
  const ctx: ServerCtx = {
    fastify: null as unknown as ServerCtx['fastify'],
  };

  beforeAll(async () => {
    const config = buildTestAppConfig(overrides);
    const { fastify } = await createServer(config);
    await fastify.ready();
    ctx.fastify = fastify;
  });

  afterAll(async () => {
    await ctx.fastify.close();
  });

  return ctx;
}
