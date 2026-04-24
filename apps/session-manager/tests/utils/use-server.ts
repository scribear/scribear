import { LogLevel } from '@scribear/base-fastify-server';
import { afterAll, beforeAll, inject } from 'vitest';

import type { AppConfig } from '#src/app-config/app-config.js';
import createServer from '#src/server/create-server.js';

export const TEST_ADMIN_KEY = 'test-admin-key';
export const ADMIN_HEADER = `Bearer ${TEST_ADMIN_KEY}`;

type ServerCtx = {
  fastify: Awaited<ReturnType<typeof createServer>>['fastify'];
};

export function useServer(): ServerCtx {
  const ctx: ServerCtx = {
    fastify: null as unknown as ServerCtx['fastify'],
  };

  beforeAll(async () => {
    const dbConfig = inject('dbConfig');
    const config = {
      baseConfig: {
        isDevelopment: true,
        logLevel: LogLevel.SILENT,
        port: 0,
        host: '127.0.0.1',
      },
      adminAuthConfig: { adminApiKey: TEST_ADMIN_KEY },
      dbClientConfig: dbConfig,
    } as unknown as AppConfig;

    const { fastify } = await createServer(config);
    await fastify.ready();
    ctx.fastify = fastify;
  });

  afterAll(async () => {
    await ctx.fastify.close();
  });

  return ctx;
}
