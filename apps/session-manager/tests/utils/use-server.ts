import { afterAll, beforeAll, inject } from 'vitest';

import { LogLevel } from '@scribear/base-fastify-server';
import { SHIPPED_TRANSCRIPTION_PROVIDER_IDS } from '@scribear/session-manager-schema';

import type {
  AppConfig,
  BaseConfig,
  CanaryRoomConfig,
  DemoRoomConfig,
  ScheduleManagementConfig,
  TestAudioRoomsConfig,
} from '#src/app-config/app-config.js';
import type { DBClientConfig } from '#src/db/db-client.js';
import createServer from '#src/server/create-server.js';
import type { MaterializationWorkerConfig } from '#src/server/features/schedule-management/materialization.worker.js';
import type { SessionAuthRateLimitConfig } from '#src/server/features/session-auth/session-auth.router.js';
import type { AdminAuthConfig } from '#src/server/shared/services/admin-auth.service.js';
import type { DevicePresenceConfig } from '#src/server/shared/services/device-presence.service.js';
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
  devicePresenceConfig?: Partial<DevicePresenceConfig>;
  materializationWorkerConfig?: Partial<MaterializationWorkerConfig>;
  demoRoomConfig?: Partial<DemoRoomConfig>;
  testAudioRoomsConfig?: Partial<TestAudioRoomsConfig>;
  canaryRoomConfig?: Partial<CanaryRoomConfig>;
  scheduleManagementConfig?: Partial<ScheduleManagementConfig>;
  sessionAuthRateLimitConfig?: Partial<SessionAuthRateLimitConfig>;
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
    // Every section here must be present even if a suite never overrides it:
    // this object is cast to AppConfig, so an omitted section arrives as
    // `undefined` at whatever depends on it rather than failing to compile.
    devicePresenceConfig: {
      // Zero so each request writes, which is what a presence test wants to
      // observe. Production coalesces; see DevicePresenceConfig.
      writeIntervalMs: 0,
      onlineTtlMs: 180_000,
      ...overrides.devicePresenceConfig,
    },
    materializationWorkerConfig: {
      enabled: false,
      intervalMs: 60_000,
      staleAfterMs: 24 * 60 * 60 * 1000,
      maxRoomsPerTick: 1000,
      ...overrides.materializationWorkerConfig,
    },
    // Off by default so ordinary suites never seed a demo room; suites
    // exercising the seeder itself pass `{ demoRoomConfig: { enabled: true } }`.
    demoRoomConfig: {
      enabled: false,
      sessionUid: 'deadbeef-0000-4000-8000-000000000001',
      ...overrides.demoRoomConfig,
    },
    // Off by default for the same reason as the demo room: ordinary suites
    // must not find two seeded rooms and four seeded rows in their tables.
    testAudioRoomsConfig: {
      enabled: false,
      deviceSecret: '',
      ...overrides.testAudioRoomsConfig,
    },
    // Off by default for the same reason again: the canary seeder writes a
    // room, a device, a membership and a session, and no ordinary suite should
    // find them.
    canaryRoomConfig: {
      enabled: false,
      deviceSecret: '',
      ...overrides.canaryRoomConfig,
    },
    // The shipped provider set, so fixtures using `whisper` behave as they do
    // in a stock deployment. Suites that want to prove the rejection override
    // this with a narrower list.
    scheduleManagementConfig: {
      transcriptionProviderIds: [...SHIPPED_TRANSCRIPTION_PROVIDER_IDS],
      ...overrides.scheduleManagementConfig,
    },
    // Effectively unlimited by default, so no ordinary suite can be made to
    // 429 by an unrelated change to the shipped defaults. The suite that
    // exercises the limiter overrides these with numbers small enough to reach
    // in a handful of requests - which is the whole point of the limits living
    // in config: the previous test spent 100 real requests per route to reach a
    // hard-coded ceiling, and then left both routes limited for the rest of a
    // real 60-second window.
    sessionAuthRateLimitConfig: {
      exchangeJoinCodeMax: 1_000_000,
      exchangeJoinCodeWindowMs: 60_000,
      failedExchangeJoinCodeMax: 1_000_000,
      failedExchangeJoinCodeWindowMs: 60_000,
      refreshSessionTokenMax: 1_000_000,
      refreshSessionTokenWindowMs: 60_000,
      ...overrides.sessionAuthRateLimitConfig,
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
