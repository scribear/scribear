import { afterEach, beforeEach, describe, expect } from 'vitest';

import { SessionManagerMock } from '#tests/utils/mock-session-manager.js';
import { useDb } from '#tests/utils/use-db.js';
import { TEST_ADMIN_KEY, login, useServer } from '#tests/utils/use-server.js';

const URL = '/api/admin/v1/demo-room/status';
const DEMO_UID = 'deadbeef-0000-4000-8000-000000000001';

describe('Demo room routes', () => {
  const server = useServer();
  useDb();
  let sm: SessionManagerMock;
  beforeEach(() => {
    sm = new SessionManagerMock();
  });
  afterEach(() => {
    sm.restore();
  });

  describe('auth guard', (it) => {
    it('rejects an unauthenticated request with 401 and makes NO upstream call', async () => {
      // Act
      const res = await server.fastify.inject({ method: 'GET', url: URL });

      // Assert
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'UNAUTHENTICATED',
      );
      expect(sm.requests.length).toBe(0);
    });
  });

  describe('status passthrough', (it) => {
    it('returns the running status and injects the admin key upstream', async () => {
      // Arrange
      const upstreamBody = {
        enabled: true,
        sessionUid: DEMO_UID,
        active: true,
        roomName: 'Demo — Alice in Wonderland',
        joinCode: 'ABCD1234',
      };
      sm.respondWith({ status: 200, body: upstreamBody });
      const { cookie } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      // Assert — envelope passthrough
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, data: upstreamBody });
      // Assert — the admin key is injected server-side, never from the browser
      const upstream = sm.requests.find((r) =>
        r.url.includes('/demo-room/status'),
      );
      expect(upstream).toBeDefined();
      expect(upstream?.headers['authorization']).toBe(
        `Bearer ${TEST_ADMIN_KEY}`,
      );
    });

    it('passes a disabled upstream status through unchanged', async () => {
      // Arrange
      const upstreamBody = {
        enabled: false,
        sessionUid: DEMO_UID,
        active: false,
        roomName: null,
        joinCode: null,
      };
      sm.respondWith({ status: 200, body: upstreamBody });
      const { cookie } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, data: upstreamBody });
    });
  });
});
