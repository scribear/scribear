import { afterAll, beforeAll, inject } from 'vitest';

import { LogLevel } from '@scribear/base-fastify-server';

import type {
  AppConfig,
  BaseConfig,
  SessionManagerClientConfig,
  TranscriptionServiceClientConfig,
} from '#src/app-config/app-config.js';
import createServer from '#src/server/create-server.js';
import type { SessionTokenConfig } from '#src/server/shared/services/session-token.service.js';

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
  sessionTokenConfig?: Partial<SessionTokenConfig>;
  sessionManagerClientConfig?: Partial<SessionManagerClientConfig>;
  transcriptionServiceClientConfig?: Partial<TranscriptionServiceClientConfig>;
}

/**
 * Builds an `AppConfig` for integration tests, wired to the in-process
 * Session Manager and Transcription Service spun up by
 * `tests/integration/global-setup.ts`. Tests pass `overrides` to flip only
 * the fields they care about (e.g. `{ baseConfig: { isDevelopment: true } }`)
 * without having to repeat the rest of the config.
 *
 * Must be called inside a vitest hook (`beforeAll`, `it`, ...), because
 * `inject` is only valid in those contexts.
 */
export function buildTestAppConfig(
  overrides: TestAppConfigOverrides = {},
): AppConfig {
  const sessionManagerBaseUrl = inject('sessionManagerBaseUrl');
  const transcriptionServiceBaseUrl = inject('transcriptionServiceBaseUrl');
  const serviceApiKey = inject('serviceApiKey');
  const sessionTokenSigningKey = inject('sessionTokenSigningKey');
  const transcriptionApiKey = inject('transcriptionApiKey');

  return {
    baseConfig: {
      isDevelopment: false,
      logLevel: LogLevel.SILENT,
      port: 0,
      host: '127.0.0.1',
      ...overrides.baseConfig,
    },
    sessionTokenConfig: {
      signingKey: sessionTokenSigningKey,
      ...overrides.sessionTokenConfig,
    },
    sessionManagerClientConfig: {
      baseUrl: sessionManagerBaseUrl,
      serviceApiKey,
      ...overrides.sessionManagerClientConfig,
    },
    transcriptionServiceClientConfig: {
      baseUrl: transcriptionServiceBaseUrl,
      apiKey: transcriptionApiKey,
      ...overrides.transcriptionServiceClientConfig,
    },
  } as unknown as AppConfig;
}

/**
 * Boots an in-process Node Server for integration tests, wired to the live
 * Session Manager (in-process) and Transcription Service (Docker container)
 * spun up by `tests/integration/global-setup.ts`.
 *
 * Tests that want to short-circuit the orchestrator can re-register
 * `transcriptionOrchestratorService` on `server.fastify.diContainer` after
 * the `beforeAll` hook has resolved (see the existing routes test).
 *
 * `overrides` are forwarded to `buildTestAppConfig` so suites can spin up the
 * server with non-default config (e.g. `{ baseConfig: { isDevelopment: true } }`).
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
