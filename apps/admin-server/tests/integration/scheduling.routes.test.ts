import { afterEach, beforeEach, describe, expect } from 'vitest';

import { SessionManagerMock } from '#tests/utils/mock-session-manager.js';
import { useDb } from '#tests/utils/use-db.js';
import { TEST_ADMIN_KEY, login, useServer } from '#tests/utils/use-server.js';

const BASE = '/api/admin/v1';
const ROOM_UID = '11111111-1111-1111-1111-111111111111';
const SCHEDULE_UID = '22222222-2222-2222-2222-222222222222';

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

describe('Scheduling routes', () => {
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
});
