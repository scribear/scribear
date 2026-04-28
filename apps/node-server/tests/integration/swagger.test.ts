import { afterAll, describe, expect } from 'vitest';

import createServer from '#src/server/create-server.js';
import { buildTestAppConfig } from '#tests/utils/use-server.js';

describe('Swagger UI', () => {
  describe('development mode', (it) => {
    let fastify:
      | Awaited<ReturnType<typeof createServer>>['fastify']
      | undefined;

    afterAll(async () => {
      await fastify?.close();
    });

    it('serves the Swagger UI at /api-docs when isDevelopment is true', async () => {
      // Arrange
      const config = buildTestAppConfig({
        baseConfig: { isDevelopment: true },
      });
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
    let fastify:
      | Awaited<ReturnType<typeof createServer>>['fastify']
      | undefined;

    afterAll(async () => {
      await fastify?.close();
    });

    it('returns 404 for /api-docs when isDevelopment is false', async () => {
      // Arrange
      const config = buildTestAppConfig({
        baseConfig: { isDevelopment: false },
      });
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
