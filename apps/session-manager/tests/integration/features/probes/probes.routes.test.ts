import { LogLevel } from '@scribear/base-fastify-server';
import { afterAll, describe, expect, inject } from 'vitest';

import type { AppConfig } from '#src/app-config/app-config.js';
import createServer from '#src/server/create-server.js';
import { TEST_ADMIN_KEY, useServer } from '#tests/utils/use-server.js';

const BASE = '/api/session-manager/v1/probes';

describe('Probes Routes', () => {
  const server = useServer();

  describe('GET /liveness', (it) => {
    it('returns 200 with status ok', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/liveness`,
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ status: string }>().status).toBe('ok');
    });
  });

  describe('GET /readiness', (it) => {
    it('returns 200 with status ok when the database is reachable', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/readiness`,
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ status: string }>().status).toBe('ok');
    });

    it('returns 503 with database fail when the database is unreachable', async () => {
      // Arrange - spin up a server pointing at a non-existent database host
      const brokenConfig = {
        baseConfig: { isDevelopment: false, logLevel: LogLevel.SILENT, port: 0, host: '127.0.0.1' },
        adminAuthConfig: { adminApiKey: TEST_ADMIN_KEY },
        dbClientConfig: {
          ...inject('dbConfig'),
          dbHost: '127.0.0.1',
          dbPort: 1,
        },
        materializationWorkerConfig: {
          enabled: false,
          intervalMs: 60_000,
          staleAfterMs: 24 * 60 * 60 * 1000,
          maxRoomsPerTick: 1000,
        },
      } as unknown as AppConfig;
      const { fastify } = await createServer(brokenConfig);
      await fastify.ready();

      // Act
      const res = await fastify.inject({ method: 'GET', url: `${BASE}/readiness` });
      await fastify.close();

      // Assert
      expect(res.statusCode).toBe(503);
      const body = res.json<{ status: string; checks: { database: string } }>();
      expect(body.status).toBe('fail');
      expect(body.checks.database).toBe('fail');
    });
  });
});
