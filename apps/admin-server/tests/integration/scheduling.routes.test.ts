import { afterEach, beforeEach, describe, expect } from 'vitest';

import { SessionManagerMock } from '#tests/utils/mock-session-manager.js';
import { useDb } from '#tests/utils/use-db.js';
import { TEST_ADMIN_KEY, login, useServer } from '#tests/utils/use-server.js';

const BASE = '/api/admin/v1';
const ROOM_UID = '11111111-1111-1111-1111-111111111111';
const SCHEDULE_UID = '22222222-2222-2222-2222-222222222222';
const WINDOW_UID = '33333333-3333-3333-3333-333333333333';

const SAMPLE_SCHEDULE = {
  uid: SCHEDULE_UID,
  roomUid: ROOM_UID,
  name: 'Weekly Standup',
  activeStart: '2026-08-01T00:00:00.000Z',
  activeEnd: null,
  anchorStart: '2026-08-01T00:00:00.000Z',
  localStartTime: '09:00',
  localEndTime: '10:00',
  frequency: 'WEEKLY',
  daysOfWeek: ['MON'],
  joinCodeScopes: ['SEND_AUDIO'],
  transcriptionProviderId: 'provider-1',
  transcriptionStreamConfig: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const SAMPLE_AUTO_WINDOW = {
  uid: WINDOW_UID,
  roomUid: ROOM_UID,
  localStartTime: '09:00',
  localEndTime: '10:00',
  daysOfWeek: ['MON'],
  joinCodeScopes: ['SEND_AUDIO'],
  transcriptionProviderId: 'provider-1',
  transcriptionStreamConfig: null,
  activeStart: '2026-08-01T00:00:00.000Z',
  activeEnd: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

const SAMPLE_ROOM = {
  uid: ROOM_UID,
  name: 'Room 101',
  timezone: 'America/Chicago',
  autoSessionEnabled: true,
  roomScheduleVersion: 2,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('Scheduling routes', () => {
  const server = useServer({ rateLimitConfig: { loginMax: 20 } });
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
        url: `${BASE}/schedules/list?roomUid=${ROOM_UID}`,
      });

      // Assert
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'UNAUTHENTICATED',
      );
      expect(sm.requests.length).toBe(0);
    });
  });

  describe('CSRF + audit on mutations', (it) => {
    const createPayload = {
      roomUid: ROOM_UID,
      name: 'Weekly Standup',
      activeStart: '2026-08-01T00:00:00.000Z',
      activeEnd: null,
      localStartTime: '09:00',
      localEndTime: '10:00',
      frequency: 'WEEKLY',
      daysOfWeek: ['MON'],
      joinCodeScopes: ['SEND_AUDIO'],
      transcriptionProviderId: 'provider-1',
      transcriptionStreamConfig: null,
    };

    it('rejects a create without a CSRF token (403) and makes NO upstream call', async () => {
      // Arrange
      sm.respondWith({ status: 201, body: SAMPLE_SCHEDULE });
      const { cookie } = await login(server.fastify);

      // Act — authenticated but no x-csrf-token header
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/schedules/create`,
        headers: { cookie },
        payload: createPayload,
      });

      // Assert
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'CSRF_TOKEN_INVALID',
      );
      const created = sm.requests.find((r) =>
        r.url.includes('/schedule-management/create-schedule'),
      );
      expect(created).toBeUndefined();
    });

    it('creates a schedule with a CSRF token, injects the key, and writes an audit record', async () => {
      // Arrange
      sm.respondWith({ status: 201, body: SAMPLE_SCHEDULE });
      const { cookie, csrfToken } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/schedules/create`,
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: createPayload,
      });

      // Assert — response
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ ok: true, data: SAMPLE_SCHEDULE });

      // Assert — upstream got the key + body
      const created = sm.requests.find((r) =>
        r.url.includes('/schedule-management/create-schedule'),
      );
      expect(created?.headers['authorization']).toBe(
        `Bearer ${TEST_ADMIN_KEY}`,
      );
      expect(created?.body).toMatchObject({ name: 'Weekly Standup' });

      // Assert — audit row persisted
      const rows = await dbCtx.db
        .selectFrom('admin_audit_log')
        .selectAll()
        .where('action', '=', 'create-schedule')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_subject).toBe('engrit');
      expect(rows[0]?.result).toBe('success');
      expect(rows[0]?.status_code).toBe(201);
    });
  });

  describe('auto-windows/create', (it) => {
    const createWindowPayload = {
      roomUid: ROOM_UID,
      localStartTime: '09:00',
      localEndTime: '10:00',
      daysOfWeek: ['MON'],
      activeStart: '2026-08-01T00:00:00.000Z',
      activeEnd: null,
      joinCodeScopes: ['SEND_AUDIO'],
      transcriptionProviderId: 'provider-1',
      transcriptionStreamConfig: null,
    };

    it('rejects an unauthenticated create with 401 and makes NO upstream call', async () => {
      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/auto-windows/create`,
        payload: createWindowPayload,
      });

      // Assert
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'UNAUTHENTICATED',
      );
      expect(sm.requests.length).toBe(0);
    });

    it('rejects a create without a CSRF token (403) and makes NO upstream call', async () => {
      // Arrange
      sm.respondWith({ status: 201, body: SAMPLE_AUTO_WINDOW });
      const { cookie } = await login(server.fastify);

      // Act — authenticated but no x-csrf-token header
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/auto-windows/create`,
        headers: { cookie },
        payload: createWindowPayload,
      });

      // Assert
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'CSRF_TOKEN_INVALID',
      );
      const created = sm.requests.find((r) =>
        r.url.includes('/schedule-management/create-auto-session-window'),
      );
      expect(created).toBeUndefined();
    });

    it('creates an auto-window with a CSRF token, injects the key, and writes an audit record', async () => {
      // Arrange
      sm.respondWith({ status: 201, body: SAMPLE_AUTO_WINDOW });
      const { cookie, csrfToken } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/auto-windows/create`,
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: createWindowPayload,
      });

      // Assert — response
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ ok: true, data: SAMPLE_AUTO_WINDOW });

      // Assert — upstream got the key + body
      const created = sm.requests.find((r) =>
        r.url.includes('/schedule-management/create-auto-session-window'),
      );
      expect(created?.headers['authorization']).toBe(
        `Bearer ${TEST_ADMIN_KEY}`,
      );
      expect(created?.body).toMatchObject({ roomUid: ROOM_UID });

      // Assert — audit row persisted
      const rows = await dbCtx.db
        .selectFrom('admin_audit_log')
        .selectAll()
        .where('action', '=', 'create-auto-session-window')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_subject).toBe('engrit');
      expect(rows[0]?.result).toBe('success');
      expect(rows[0]?.status_code).toBe(201);
    });
  });

  describe('schedules/room-config', (it) => {
    const roomConfigPayload = {
      roomUid: ROOM_UID,
      autoSessionEnabled: false,
    };

    it('rejects an unauthenticated update with 401 and makes NO upstream call', async () => {
      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/schedules/room-config`,
        payload: roomConfigPayload,
      });

      // Assert
      expect(res.statusCode).toBe(401);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'UNAUTHENTICATED',
      );
      expect(sm.requests.length).toBe(0);
    });

    it('rejects an update without a CSRF token (403) and makes NO upstream call', async () => {
      // Arrange
      sm.respondWith({ status: 200, body: SAMPLE_ROOM });
      const { cookie } = await login(server.fastify);

      // Act — authenticated but no x-csrf-token header
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/schedules/room-config`,
        headers: { cookie },
        payload: roomConfigPayload,
      });

      // Assert
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'CSRF_TOKEN_INVALID',
      );
      const updated = sm.requests.find((r) =>
        r.url.includes('/schedule-management/update-room-schedule-config'),
      );
      expect(updated).toBeUndefined();
    });

    it('updates room schedule config with a CSRF token, injects the key, and writes an audit record', async () => {
      // Arrange
      sm.respondWith({ status: 200, body: SAMPLE_ROOM });
      const { cookie, csrfToken } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/schedules/room-config`,
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: roomConfigPayload,
      });

      // Assert — response
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, data: SAMPLE_ROOM });

      // Assert — upstream got the key + body
      const updated = sm.requests.find((r) =>
        r.url.includes('/schedule-management/update-room-schedule-config'),
      );
      expect(updated?.headers['authorization']).toBe(
        `Bearer ${TEST_ADMIN_KEY}`,
      );
      expect(updated?.body).toMatchObject({
        roomUid: ROOM_UID,
        autoSessionEnabled: false,
      });

      // Assert — audit row persisted
      const rows = await dbCtx.db
        .selectFrom('admin_audit_log')
        .selectAll()
        .where('action', '=', 'update-room-schedule-config')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor_subject).toBe('engrit');
      expect(rows[0]?.result).toBe('success');
      expect(rows[0]?.status_code).toBe(200);
    });
  });
});
