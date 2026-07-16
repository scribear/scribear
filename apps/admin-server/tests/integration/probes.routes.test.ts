import { describe, expect } from 'vitest';

import { useServer } from '#tests/utils/use-server.js';

const BASE = '/api/admin/v1/probes';

describe('Probes routes', () => {
  const server = useServer();

  describe('GET /liveness', (it) => {
    it('returns 200 with status ok (no auth required)', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/liveness`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ status: string }>().status).toBe('ok');
    });
  });

  describe('GET /readiness', (it) => {
    it('returns 200 with status ok when the database is reachable', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/readiness`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ status: string }>().status).toBe('ok');
    });
  });
});
