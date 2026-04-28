import { LogLevel } from '@scribear/base-fastify-server';
import { afterAll, describe, expect, inject } from 'vitest';

import type { AppConfig } from '#src/app-config/app-config.js';
import createServer from '#src/server/create-server.js';
import { TEST_ADMIN_KEY } from '#tests/utils/use-server.js';

describe('Swagger UI', () => {
  describe('development mode', (it) => {
    let fastify: Awaited<ReturnType<typeof createServer>>['fastify'];

    afterAll(async () => { await fastify?.close(); });

    it('serves the Swagger UI at /api-docs when isDevelopment is true', async () => {
      // Arrange
      const dbConfig = inject('dbConfig');
      const config = {
        baseConfig: { isDevelopment: true, logLevel: LogLevel.SILENT, port: 0, host: '127.0.0.1' },
        adminAuthConfig: { adminApiKey: TEST_ADMIN_KEY },
        dbClientConfig: dbConfig,
        materializationWorkerConfig: {
          enabled: false,
          intervalMs: 60_000,
          staleAfterMs: 24 * 60 * 60 * 1000,
          maxRoomsPerTick: 1000,
        },
      } as unknown as AppConfig;
      const server = await createServer(config);
      fastify = server.fastify;
      await fastify.ready();

      // Act
      const res = await fastify.inject({ method: 'GET', url: '/api-docs' });

      // Assert - UI is mounted; exact status depends on the swagger-ui version
      expect(res.statusCode).not.toBe(404);
    });
  });

  describe('production mode', (it) => {
    let fastify: Awaited<ReturnType<typeof createServer>>['fastify'];

    afterAll(async () => { await fastify?.close(); });

    it('returns 404 for /api-docs when isDevelopment is false', async () => {
      // Arrange
      const dbConfig = inject('dbConfig');
      const config = {
        baseConfig: { isDevelopment: false, logLevel: LogLevel.SILENT, port: 0, host: '127.0.0.1' },
        adminAuthConfig: { adminApiKey: TEST_ADMIN_KEY },
        dbClientConfig: dbConfig,
        materializationWorkerConfig: {
          enabled: false,
          intervalMs: 60_000,
          staleAfterMs: 24 * 60 * 60 * 1000,
          maxRoomsPerTick: 1000,
        },
      } as unknown as AppConfig;
      const server = await createServer(config);
      fastify = server.fastify;
      await fastify.ready();

      // Act
      const res = await fastify.inject({ method: 'GET', url: '/api-docs' });

      // Assert
      expect(res.statusCode).toBe(404);
    });
  });
});
