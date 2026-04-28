import { asValue } from 'awilix';
import { afterEach, describe, expect } from 'vitest';

import { useServer } from '#tests/utils/use-server.js';

const BASE = '/api/node-server/v1/probes';

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
    let originalSessionManagerClient:
      | (typeof server.fastify.diContainer.cradle)['sessionManagerClient']
      | null = null;

    afterEach(() => {
      if (originalSessionManagerClient !== null) {
        server.fastify.diContainer.register({
          sessionManagerClient: asValue(originalSessionManagerClient),
        });
        originalSessionManagerClient = null;
      }
    });

    it('returns 200 ok when Session Manager is reachable', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/readiness`,
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ status: string }>().status).toBe('ok');
    });

    it('returns 503 with sessionManager: fail when the probe call errors', async () => {
      // Arrange - swap in a fake session-manager-client whose probes.liveness
      // resolves to the error slot of the EndpointResult tuple.
      originalSessionManagerClient =
        server.fastify.diContainer.resolve('sessionManagerClient');
      const failingClient = {
        ...originalSessionManagerClient,
        probes: {
          liveness: async () => [
            null,
            new Error('synthetic readiness failure'),
          ],
          readiness: async () => [null, new Error('not used')],
        },
      };
      server.fastify.diContainer.register({
        sessionManagerClient: asValue(failingClient as never),
      });

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/readiness`,
      });

      // Assert
      expect(res.statusCode).toBe(503);
      const body = res.json<{
        status: string;
        checks: { sessionManager: string };
      }>();
      expect(body.status).toBe('fail');
      expect(body.checks.sessionManager).toBe('fail');
    });
  });
});
