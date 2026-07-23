import { afterAll, beforeAll, inject } from 'vitest';

import { LogLevel } from '@scribear/base-fastify-server';

import type { AppConfig } from '#src/app-config/app-config.js';
import createServer from '#src/server/create-server.js';

export const TEST_ADMIN_KEY = 'test-admin-key';
export const TEST_USERNAME = 'engrit';
export const TEST_PASSWORD = 'super secret pw!';
export const TEST_LOCAL_CREDENTIALS = `${TEST_USERNAME} ${TEST_PASSWORD}`;
export const TEST_SM_BASE_URL = 'http://session-manager.test';
export const TEST_NODE_BASE_URL = 'http://node-server.test';
export const TEST_TS_BASE_URL = 'http://transcription-service.test';
export const TEST_COOKIE_SECRET =
  'test-cookie-secret-at-least-32-characters-long!!';

export interface TestAppConfigOverrides {
  baseConfig?: Partial<AppConfig['baseConfig']>;
  sessionManagerGatewayConfig?: Partial<
    AppConfig['sessionManagerGatewayConfig']
  >;
  sessionConfig?: Partial<AppConfig['sessionConfig']>;
  localAuthConfig?: Partial<AppConfig['localAuthConfig']>;
  azureAuthConfig?: Partial<AppConfig['azureAuthConfig']>;
  rateLimitConfig?: Partial<AppConfig['rateLimitConfig']>;
  dbClientConfig?: Partial<AppConfig['dbClientConfig']>;
  healthCheckerConfig?: Partial<AppConfig['healthCheckerConfig']>;
  fleetTelemetryConfig?: Partial<AppConfig['fleetTelemetryConfig']>;
  configCheckConfig?: Partial<AppConfig['configCheckConfig']>;
  cookieSecret?: string;
}

/**
 * Builds an `AppConfig` for integration tests, wired to the postgres container
 * from `tests/integration/global-setup.ts`. Must be called inside a vitest hook.
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
    sessionManagerGatewayConfig: {
      adminApiKey: TEST_ADMIN_KEY,
      sessionManagerBaseUrl: TEST_SM_BASE_URL,
      ...overrides.sessionManagerGatewayConfig,
    },
    sessionConfig: {
      // Non-secure so the cookie is sent in `inject` (no TLS in tests).
      secure: false,
      idleTimeoutMs: 60 * 60 * 1000,
      absoluteTimeoutMs: 8 * 60 * 60 * 1000,
      ...overrides.sessionConfig,
    },
    localAuthConfig: {
      credentials: TEST_LOCAL_CREDENTIALS,
      ...overrides.localAuthConfig,
    },
    azureAuthConfig: {
      tenantId: '',
      clientId: '',
      clientSecret: '',
      redirectUri: '',
      allowedGroup: '',
      ...overrides.azureAuthConfig,
    },
    rateLimitConfig: {
      globalMax: 1000,
      globalWindowMs: 60_000,
      loginMax: 5,
      loginWindowMs: 60_000,
      ...overrides.rateLimitConfig,
    },
    healthCheckerConfig: {
      // Short: these targets are stubbed, so a real timeout would only ever be
      // hit by a test that meant to hit it.
      timeoutMs: 500,
      targets: [
        {
          name: 'session-manager',
          readinessUrl: `${TEST_SM_BASE_URL}/api/session-manager/v1/probes/readiness`,
        },
        {
          name: 'node-server',
          readinessUrl: `${TEST_NODE_BASE_URL}/api/node-server/v1/probes/readiness`,
        },
        {
          name: 'transcription-service',
          readinessUrl: `${TEST_TS_BASE_URL}/probes/readiness`,
        },
      ],
      ...overrides.healthCheckerConfig,
    },
    dbClientConfig: { ...dbConfig, ...overrides.dbClientConfig },
    // Disabled by default, like a deployment that predates B1.7 — tests that
    // exercise the fleet backplane pass the real container's URL explicitly.
    fleetTelemetryConfig: {
      redisUrl: '',
      ...overrides.fleetTelemetryConfig,
    },
    // A deployment with nothing wrong with it, so a test that cares about a
    // finding can spoil exactly one thing and assert on it. `declaredEnv` is
    // explicit rather than inferred because `isDevelopment` is true above,
    // which would otherwise make every test a development-severity test.
    configCheckConfig: {
      declaredEnv: 'production',
      isDevelopment: false,
      adminApiKey: TEST_ADMIN_KEY,
      adminSessionSecret: TEST_COOKIE_SECRET,
      adminLocalCredentials: TEST_LOCAL_CREDENTIALS,
      dbPassword: 'test-db-password',
      redisUrl: 'redis://:test-redis-password@redis.test:6379',
      azureTenantId: 'test-tenant',
      azureClientId: 'test-client',
      azureClientSecret: 'test-client-secret',
      allowedGroup: 'test-admins',
      ...overrides.configCheckConfig,
    },
    cookieSecret: overrides.cookieSecret ?? TEST_COOKIE_SECRET,
  } as unknown as AppConfig;
}

interface ServerCtx {
  fastify: Awaited<ReturnType<typeof createServer>>['fastify'];
}

/**
 * Boots an in-process admin BFF for integration tests, wired to the postgres
 * container spun up by `tests/integration/global-setup.ts`.
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

/**
 * Log in and return the raw `set-cookie` header value(s) plus the CSRF token
 * from the response body, for use in subsequent authenticated requests.
 */
export async function login(
  fastify: ServerCtx['fastify'],
  username = TEST_USERNAME,
  password = TEST_PASSWORD,
): Promise<{ statusCode: number; cookie: string; csrfToken: string }> {
  const res = await fastify.inject({
    method: 'POST',
    url: '/api/admin/v1/auth/login',
    payload: { username, password },
  });

  const setCookie = res.headers['set-cookie'];
  const cookie = Array.isArray(setCookie)
    ? (setCookie[0] ?? '')
    : (setCookie ?? '');
  // Only the name=value part is needed for the request `cookie` header.
  const cookiePair = cookie.split(';')[0] ?? '';

  let csrfToken = '';
  if (res.statusCode === 200) {
    csrfToken = res.json<{ data: { csrfToken: string } }>().data.csrfToken;
  }

  return { statusCode: res.statusCode, cookie: cookiePair, csrfToken };
}
