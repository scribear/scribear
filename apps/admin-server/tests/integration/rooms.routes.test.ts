import { afterEach, beforeEach, describe, expect } from 'vitest';

import { SessionManagerMock } from '#tests/utils/mock-session-manager.js';
import { useDb } from '#tests/utils/use-db.js';
import { TEST_ADMIN_KEY, login, useServer } from '#tests/utils/use-server.js';

const BASE = '/api/admin/v1';
const UUID = '11111111-1111-1111-1111-111111111111';

const SAMPLE_ROOM = {
  uid: UUID,
  name: 'Room A',
  timezone: 'America/New_York',
  autoSessionEnabled: false,
  roomScheduleVersion: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('Rooms routes', () => {
  const server = useServer();
  const dbCtx = useDb();
  let sm: SessionManagerMock;
  beforeEach(() => {
    sm = new SessionManagerMock();
  });
  afterEach(() => {
    sm.restore();
  });

  describe('auth guard', (it) => {
    it('rejects an unauthenticated list with 401 and makes NO upstream call', async () => {
      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/rooms/list`,
      });

      // Assert
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'UNAUTHENTICATED',
      );
      expect(sm.requests.length).toBe(0);
    });
  });

  describe('key injection + envelope mapping', (it) => {
    it('lists rooms and injects the admin key upstream (never from the browser)', async () => {
      // Arrange
      sm.respondWith({ status: 200, body: { items: [], nextCursor: null } });
      const { cookie } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/rooms/list`,
        headers: { cookie },
      });

      // Assert — envelope
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        data: { items: [], nextCursor: null },
      });
      // Assert — the outgoing upstream request carried the Bearer admin key
      const upstream = sm.requests.find((r) =>
        r.url.includes('/room-management/list-rooms'),
      );
      expect(upstream).toBeDefined();
      expect(upstream?.headers['authorization']).toBe(
        `Bearer ${TEST_ADMIN_KEY}`,
      );
    });

    it('passes an upstream 404 through as a 404 error envelope', async () => {
      // Arrange
      sm.respondWith({
        status: 404,
        body: { code: 'ROOM_NOT_FOUND', message: 'nope' },
      });
      const { cookie } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/rooms/get/${UUID}`,
        headers: { cookie },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      const body = res.json<{
        ok: boolean;
        error: { code: string; requestId: string };
      }>();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('ROOM_NOT_FOUND');
      expect(typeof body.error.requestId).toBe('string');
    });

    it('maps an upstream 401 (rejected admin key) to 502 BACKEND_MISCONFIGURATION', async () => {
      // Arrange — Session Manager rejects our admin key.
      sm.respondWith({
        status: 401,
        body: { code: 'INVALID_ADMIN_KEY', message: 'bad key' },
      });
      const { cookie } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/rooms/list`,
        headers: { cookie },
      });

      // Assert — must NOT surface as a 401 (which would bounce the user to login).
      expect(res.statusCode).toBe(502);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'BACKEND_MISCONFIGURATION',
      );
    });
  });

  describe('CSRF + audit on mutations', (it) => {
    const createPayload = {
      name: 'Room A',
      timezone: 'America/New_York',
      autoSessionEnabled: false,
      sourceDeviceUids: [UUID],
    };

    it('rejects a create without a CSRF token (403) and makes NO upstream call', async () => {
      // Arrange
      sm.respondWith({ status: 201, body: SAMPLE_ROOM });
      const { cookie } = await login(server.fastify);

      // Act — authenticated but no x-csrf-token header
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/rooms/create`,
        headers: { cookie },
        payload: createPayload,
      });

      // Assert
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'CSRF_TOKEN_INVALID',
      );
      const created = sm.requests.find((r) =>
        r.url.includes('/room-management/create-room'),
      );
      expect(created).toBeUndefined();
    });

    it('creates a room with a CSRF token, injects the key, and writes an audit record', async () => {
      // Arrange
      sm.respondWith({ status: 201, body: SAMPLE_ROOM });
      const { cookie, csrfToken } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/rooms/create`,
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: createPayload,
      });

      // Assert — response
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ ok: true, data: SAMPLE_ROOM });

      // Assert — upstream got the key + body
      const created = sm.requests.find((r) =>
        r.url.includes('/room-management/create-room'),
      );
      expect(created?.headers['authorization']).toBe(
        `Bearer ${TEST_ADMIN_KEY}`,
      );
      expect(created?.body).toMatchObject({ name: 'Room A' });

      // Assert — audit row persisted
      const rows = await dbCtx.db
        .selectFrom('admin_audit_log')
        .selectAll()
        .where('action', '=', 'create-room')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_subject).toBe('engrit');
      expect(rows[0]?.result).toBe('success');
      expect(rows[0]?.status_code).toBe(201);
    });
  });
});
