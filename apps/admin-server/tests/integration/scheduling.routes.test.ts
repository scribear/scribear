import { afterEach, beforeEach, describe, expect } from 'vitest';

import { SessionManagerMock } from '#tests/utils/mock-session-manager.js';
import { useDb } from '#tests/utils/use-db.js';
import { TEST_ADMIN_KEY, login, useServer } from '#tests/utils/use-server.js';

const BASE = '/api/admin/v1';
const ROOM_UID = '11111111-1111-1111-1111-111111111111';
const SCHEDULE_UID = '22222222-2222-2222-2222-222222222222';
const WINDOW_UID = '33333333-3333-3333-3333-333333333333';
const SESSION_UID = '44444444-4444-4444-4444-444444444441';

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

const SAMPLE_SESSION = {
  uid: SESSION_UID,
  roomUid: ROOM_UID,
  name: 'Weekly Standup',
  type: 'SCHEDULED',
  scheduledSessionUid: SCHEDULE_UID,
  scheduledStartTime: '2026-08-03T09:00:00.000Z',
  scheduledEndTime: '2026-08-03T10:00:00.000Z',
  startOverride: null,
  endOverride: null,
  canceledAt: null,
  effectiveStart: '2026-08-03T09:00:00.000Z',
  effectiveEnd: '2026-08-03T10:00:00.000Z',
  joinCodeScopes: ['SEND_AUDIO'],
  transcriptionProviderId: 'provider-1',
  transcriptionStreamConfig: null,
  sessionConfigVersion: 1,
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
  // Raised from the default (5/min) - this file logs in once per test to keep
  // each test's auth state independent, which adds up across the extra
  // sessions-route coverage below.
  const server = useServer({ rateLimitConfig: { loginMax: 30 } });
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

  describe('sessions/join-code', (it) => {
    const JOIN_CODE_SESSION_UID = '55555555-5555-5555-5555-555555555555';

    it('fetches a join code and injects the admin key upstream', async () => {
      // Arrange
      sm.respondWith({
        status: 200,
        body: {
          status: 'ok',
          joinCode: 'ABC12345',
          validEnd: '2026-08-01T00:05:00.000Z',
        },
      });
      const { cookie } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/sessions/${JOIN_CODE_SESSION_UID}/join-code`,
        headers: { cookie },
      });

      // Assert — envelope
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        data: {
          status: 'ok',
          joinCode: 'ABC12345',
          validEnd: '2026-08-01T00:05:00.000Z',
        },
      });
      // Assert — upstream request
      const upstream = sm.requests.find((r) =>
        r.url.includes('/session-auth/admin-fetch-join-code'),
      );
      expect(upstream).toBeDefined();
      expect(upstream?.headers['authorization']).toBe(
        `Bearer ${TEST_ADMIN_KEY}`,
      );
      expect(upstream?.body).toMatchObject({
        sessionUid: JOIN_CODE_SESSION_UID,
      });
    });

    it('passes an upstream 404 through as a 404 error envelope', async () => {
      // Arrange
      sm.respondWith({
        status: 404,
        body: { code: 'SESSION_NOT_FOUND', message: 'nope' },
      });
      const { cookie } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/sessions/${JOIN_CODE_SESSION_UID}/join-code`,
        headers: { cookie },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      const body = res.json<{ ok: boolean; error: { code: string } }>();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('SESSION_NOT_FOUND');
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
        url: `${BASE}/sessions/${JOIN_CODE_SESSION_UID}/join-code`,
        headers: { cookie },
      });

      // Assert — must NOT surface as a 401 (which would bounce the user to login).
      expect(res.statusCode).toBe(502);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'BACKEND_MISCONFIGURATION',
      );
    });
  });

  describe('GET /sessions/list', (it) => {
    it('rejects an unauthenticated call with 401 and makes NO upstream call', async () => {
      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/sessions/list?roomUids=${ROOM_UID}&from=2026-08-01T00:00:00.000Z&to=2026-08-02T00:00:00.000Z`,
      });

      // Assert
      expect(res.statusCode).toBe(401);
      expect(sm.requests.length).toBe(0);
    });

    it('passes roomUids/from/to through to the gateway and returns the envelope', async () => {
      // Arrange
      sm.respondWith({ status: 200, body: { items: [SAMPLE_SESSION] } });
      const { cookie } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/sessions/list?roomUids=${ROOM_UID}&from=2026-08-01T00:00:00.000Z&to=2026-08-02T00:00:00.000Z`,
        headers: { cookie },
      });

      // Assert - response envelope
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        data: { items: [SAMPLE_SESSION] },
      });

      // Assert - upstream got the key + querystring, no CSRF needed (read)
      const listed = sm.requests.find((r) =>
        r.url.includes('/schedule-management/list-sessions'),
      );
      expect(listed?.headers['authorization']).toBe(`Bearer ${TEST_ADMIN_KEY}`);
      expect(listed?.url).toContain(`roomUids=${ROOM_UID}`);
      expect(listed?.url).toContain('from=2026-08-01T00%3A00%3A00.000Z');
      expect(listed?.url).toContain('to=2026-08-02T00%3A00%3A00.000Z');
    });

    it('passes an upstream ROOM_NOT_FOUND through as a 404 envelope, naming the offending room', async () => {
      // Arrange — a supplied roomUid that doesn't exist. Distinct from the
      // all-rooms query (roomUids omitted), where this 404 is unreachable.
      sm.respondWith({
        status: 404,
        body: {
          code: 'ROOM_NOT_FOUND',
          message: 'Room not found.',
          details: { roomUids: [ROOM_UID] },
        },
      });
      const { cookie } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/sessions/list?roomUids=${ROOM_UID}&from=2026-08-01T00:00:00.000Z&to=2026-08-02T00:00:00.000Z`,
        headers: { cookie },
      });

      // Assert — the 404 (and the offending room uid) survive the BFF hop
      // unflattened; only 401 and 2xx are special-cased by the gateway.
      expect(res.statusCode).toBe(404);
      const body = res.json<{
        ok: boolean;
        error: { code: string; details?: { roomUids?: string[] } };
      }>();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('ROOM_NOT_FOUND');
      expect(body.error.details?.roomUids).toEqual([ROOM_UID]);
    });
  });

  describe('sessions/active/:roomUid', (it) => {
    it('passes a null body through as "no active session", not as an error', async () => {
      // Arrange — the upstream route answers 200 with a literal `null` body to
      // keep "no session is active" distinct from "room not found" (404). A
      // gateway that treated an empty payload as a failure would turn an idle
      // room into an error banner.
      sm.respondWith({ status: 200, body: null });
      const { cookie } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/sessions/active/${ROOM_UID}`,
        headers: { cookie },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, data: null });
    });

    it('returns the active session and injects the admin key upstream', async () => {
      // Arrange
      sm.respondWith({ status: 200, body: SAMPLE_SESSION });
      const { cookie } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/sessions/active/${ROOM_UID}`,
        headers: { cookie },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, data: SAMPLE_SESSION });
      const upstream = sm.requests.find((r) =>
        r.url.includes('/get-active-session/'),
      );
      expect(upstream).toBeDefined();
      expect(upstream?.headers['authorization']).toBe(
        `Bearer ${TEST_ADMIN_KEY}`,
      );
    });

    it('passes an upstream ROOM_NOT_FOUND through as a 404 envelope', async () => {
      // Arrange — distinct from the null body above: the room itself is gone.
      sm.respondWith({
        status: 404,
        body: { code: 'ROOM_NOT_FOUND', message: 'nope' },
      });
      const { cookie } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/sessions/active/${ROOM_UID}`,
        headers: { cookie },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      const body = res.json<{ ok: boolean; error: { code: string } }>();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe('ROOM_NOT_FOUND');
    });

    it('rejects an unauthenticated read with 401 and makes NO upstream call', async () => {
      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/sessions/active/${ROOM_UID}`,
      });

      // Assert
      expect(res.statusCode).toBe(401);
      expect(sm.requests).toHaveLength(0);
    });
  });

  describe('POST /sessions/cancel', (it) => {
    it('rejects a cancel without a CSRF token (403) and makes NO upstream call', async () => {
      // Arrange
      sm.respondWith({ status: 200, body: SAMPLE_SESSION });
      const { cookie } = await login(server.fastify);

      // Act - authenticated but no x-csrf-token header
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/sessions/cancel`,
        headers: { cookie },
        payload: { sessionUid: SESSION_UID },
      });

      // Assert
      expect(res.statusCode).toBe(403);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'CSRF_TOKEN_INVALID',
      );
      const canceled = sm.requests.find((r) =>
        r.url.includes('/schedule-management/cancel-session'),
      );
      expect(canceled).toBeUndefined();
    });

    it('cancels a session with a CSRF token, injects the key, and writes an audit record', async () => {
      // Arrange
      sm.respondWith({
        status: 200,
        body: { ...SAMPLE_SESSION, canceledAt: '2026-08-02T00:00:00.000Z' },
      });
      const { cookie, csrfToken } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/sessions/cancel`,
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: { sessionUid: SESSION_UID },
      });

      // Assert - response
      expect(res.statusCode).toBe(200);
      expect(
        res.json<{ ok: boolean; data: { canceledAt: string | null } }>().data
          .canceledAt,
      ).toBe('2026-08-02T00:00:00.000Z');

      // Assert - upstream got the key + body
      const canceled = sm.requests.find((r) =>
        r.url.includes('/schedule-management/cancel-session'),
      );
      expect(canceled?.headers['authorization']).toBe(
        `Bearer ${TEST_ADMIN_KEY}`,
      );
      expect(canceled?.body).toMatchObject({ sessionUid: SESSION_UID });

      // Assert - audit row persisted
      const rows = await dbCtx.db
        .selectFrom('admin_audit_log')
        .selectAll()
        .where('action', '=', 'cancel-session')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.result).toBe('success');
      expect(rows[0]?.status_code).toBe(200);
    });

    it('preserves the error envelope shape when the upstream rejects the cancel', async () => {
      // Arrange
      sm.respondWith({
        status: 422,
        body: {
          code: 'SESSION_NOT_UPCOMING',
          message: 'Only upcoming sessions can be canceled.',
        },
      });
      const { cookie, csrfToken } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/sessions/cancel`,
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: { sessionUid: SESSION_UID },
      });

      // Assert
      expect(res.statusCode).toBe(422);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'SESSION_NOT_UPCOMING',
      );
    });
  });

  describe('POST /sessions/uncancel', (it) => {
    it('rejects an uncancel without a CSRF token (403) and makes NO upstream call', async () => {
      // Arrange
      sm.respondWith({ status: 200, body: SAMPLE_SESSION });
      const { cookie } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/sessions/uncancel`,
        headers: { cookie },
        payload: { sessionUid: SESSION_UID },
      });

      // Assert
      expect(res.statusCode).toBe(403);
      const uncanceled = sm.requests.find((r) =>
        r.url.includes('/schedule-management/uncancel-session'),
      );
      expect(uncanceled).toBeUndefined();
    });

    it('uncancels a session with a CSRF token, injects the key, and writes an audit record', async () => {
      // Arrange
      sm.respondWith({ status: 200, body: SAMPLE_SESSION });
      const { cookie, csrfToken } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/sessions/uncancel`,
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: { sessionUid: SESSION_UID },
      });

      // Assert - response
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, data: SAMPLE_SESSION });

      // Assert - upstream got the key + body
      const uncanceled = sm.requests.find((r) =>
        r.url.includes('/schedule-management/uncancel-session'),
      );
      expect(uncanceled?.headers['authorization']).toBe(
        `Bearer ${TEST_ADMIN_KEY}`,
      );
      expect(uncanceled?.body).toMatchObject({ sessionUid: SESSION_UID });

      // Assert - audit row persisted
      const rows = await dbCtx.db
        .selectFrom('admin_audit_log')
        .selectAll()
        .where('action', '=', 'uncancel-session')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.result).toBe('success');
      expect(rows[0]?.status_code).toBe(200);
    });

    it('preserves the error envelope shape when the upstream rejects the uncancel', async () => {
      // Arrange
      sm.respondWith({
        status: 409,
        body: {
          code: 'SLOT_NO_LONGER_AVAILABLE',
          message: 'Another session now occupies this time range.',
        },
      });
      const { cookie, csrfToken } = await login(server.fastify);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/sessions/uncancel`,
        headers: { cookie, 'x-csrf-token': csrfToken },
        payload: { sessionUid: SESSION_UID },
      });

      // Assert
      expect(res.statusCode).toBe(409);
      expect(res.json<{ error: { code: string } }>().error.code).toBe(
        'SLOT_NO_LONGER_AVAILABLE',
      );
    });
  });
});
