import { describe, expect } from 'vitest';

import { useDb } from '#tests/utils/use-db.js';
import { ADMIN_HEADER, useServer } from '#tests/utils/use-server.js';

const DEVICE_BASE = '/api/session-manager/v1/device-management';
const ROOM_BASE = '/api/session-manager/v1/room-management';
const SCHEDULE_BASE = '/api/session-manager/v1/schedule-management';
const SESSION_AUTH_BASE = '/api/session-manager/v1/session-auth';
const NULL_UUID = '00000000-0000-0000-0000-000000000000';

interface CreateSessionOpts {
  joinCodeScopes?: string[];
}

describe('Session Auth Routes', () => {
  const server = useServer();
  const dbContext = useDb([
    'session_join_codes',
    'session_refresh_tokens',
    'sessions',
    'session_schedules',
    'auto_session_windows',
    'rooms',
    'devices',
  ]);

  async function registerDevice(name: string) {
    const res = await server.fastify.inject({
      method: 'POST',
      url: `${DEVICE_BASE}/register-device`,
      headers: { authorization: ADMIN_HEADER },
      body: { name },
    });
    return res.json<{ deviceUid: string; activationCode: string }>();
  }

  async function activateDevice(activationCode: string): Promise<string> {
    const res = await server.fastify.inject({
      method: 'POST',
      url: `${DEVICE_BASE}/activate-device`,
      body: { activationCode },
    });
    const setCookie = res.headers['set-cookie'];
    const raw = Array.isArray(setCookie) ? setCookie[0]! : (setCookie ?? '');
    const nameValue = raw.split(';')[0]!;
    return nameValue.slice(nameValue.indexOf('=') + 1);
  }

  async function setupActivatedDevice(name: string) {
    const { deviceUid, activationCode } = await registerDevice(name);
    const token = await activateDevice(activationCode);
    return { deviceUid, token };
  }

  async function createRoomWithSource(sourceDeviceUid: string) {
    const res = await server.fastify.inject({
      method: 'POST',
      url: `${ROOM_BASE}/create-room`,
      headers: { authorization: ADMIN_HEADER },
      body: {
        name: 'Test Room',
        timezone: 'America/New_York',
        autoSessionEnabled: false,
        sourceDeviceUids: [sourceDeviceUid],
      },
    });
    return res.json<{ uid: string }>().uid;
  }

  async function addDeviceToRoom(roomUid: string, deviceUid: string) {
    await server.fastify.inject({
      method: 'POST',
      url: `${ROOM_BASE}/add-device-to-room`,
      headers: { authorization: ADMIN_HEADER },
      body: { roomUid, deviceUid, asSource: false },
    });
  }

  async function createOnDemandSession(
    roomUid: string,
    opts: CreateSessionOpts = {},
  ) {
    const res = await server.fastify.inject({
      method: 'POST',
      url: `${SCHEDULE_BASE}/create-on-demand-session`,
      headers: { authorization: ADMIN_HEADER },
      body: {
        roomUid,
        name: 'Test Session',
        joinCodeScopes: opts.joinCodeScopes ?? ['RECEIVE_TRANSCRIPTIONS'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      },
    });
    return res.json<{ uid: string }>().uid;
  }

  /**
   * Ends a session via the schedule-management end-session-early endpoint so
   * we use a real lifecycle path. Setting `end_override` directly would trip
   * the `sessions_effective_interval_valid` check for sessions whose
   * scheduled_start_time is at or after `now`.
   */
  async function endSessionEarly(sessionUid: string) {
    await server.fastify.inject({
      method: 'POST',
      url: `${SCHEDULE_BASE}/end-session-early`,
      headers: { authorization: ADMIN_HEADER },
      body: { sessionUid },
    });
  }

  /**
   * Builds an in-room source device + an active on-demand session in that
   * room, so each test can branch from a known-good baseline.
   */
  async function setupActiveSession(opts: CreateSessionOpts = {}) {
    const source = await setupActivatedDevice('Source Device');
    const roomUid = await createRoomWithSource(source.deviceUid);
    const sessionUid = await createOnDemandSession(roomUid, opts);
    return { ...source, roomUid, sessionUid };
  }

  describe('POST /fetch-join-code', (it) => {
    it('returns 401 when the device cookie is missing', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/fetch-join-code`,
        body: { sessionUid: NULL_UUID },
      });

      // Assert
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when the session does not exist', async () => {
      // Arrange
      const { token } = await setupActivatedDevice('Device');

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/fetch-join-code`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
        body: { sessionUid: NULL_UUID },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('SESSION_NOT_FOUND');
    });

    it('returns 403 when the device is not in the session room', async () => {
      // Arrange - session lives in a room owned by a different source device.
      const { sessionUid } = await setupActiveSession();
      const outsider = await setupActivatedDevice('Outsider');

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/fetch-join-code`,
        headers: { cookie: `DEVICE_TOKEN=${outsider.token}` },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe(
        'DEVICE_NOT_IN_SESSION_ROOM',
      );
    });

    it('returns 409 when the session has empty joinCodeScopes', async () => {
      // Arrange
      const { token, sessionUid } = await setupActiveSession({
        joinCodeScopes: [],
      });

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/fetch-join-code`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('JOIN_CODE_SCOPES_EMPTY');
    });

    it('returns 200 with a fresh current code on the first call', async () => {
      // Arrange
      const { token, sessionUid } = await setupActiveSession();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/fetch-join-code`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        current: { joinCode: string; validStart: string; validEnd: string };
        next: unknown;
      }>();
      expect(body.current.joinCode).toMatch(/^[A-Z0-9]{8}$/);
      expect(body.next).toBeNull();
    });

    it('is idempotent across repeated calls within the code lifetime', async () => {
      // Arrange
      const { token, sessionUid } = await setupActiveSession();
      const first = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/fetch-join-code`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
        body: { sessionUid },
      });

      // Act
      const second = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/fetch-join-code`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
        body: { sessionUid },
      });

      // Assert
      expect(second.statusCode).toBe(200);
      const firstBody = first.json<{ current: { joinCode: string } }>();
      const secondBody = second.json<{ current: { joinCode: string } }>();
      expect(secondBody.current.joinCode).toBe(firstBody.current.joinCode);
    });

    it('also works for a non-source device that is a member of the room', async () => {
      // Arrange - add a second device to the same room as a non-source.
      const { sessionUid, roomUid } = await setupActiveSession();
      const member = await setupActivatedDevice('Member');
      await addDeviceToRoom(roomUid, member.deviceUid);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/fetch-join-code`,
        headers: { cookie: `DEVICE_TOKEN=${member.token}` },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /exchange-device-token', (it) => {
    it('returns 401 when the device cookie is missing', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/exchange-device-token`,
        body: { sessionUid: NULL_UUID },
      });

      // Assert
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when the session does not exist', async () => {
      // Arrange
      const { token } = await setupActivatedDevice('Device');

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/exchange-device-token`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
        body: { sessionUid: NULL_UUID },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('SESSION_NOT_FOUND');
    });

    it('returns 403 when the device is not in the session room', async () => {
      // Arrange
      const { sessionUid } = await setupActiveSession();
      const outsider = await setupActivatedDevice('Outsider');

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/exchange-device-token`,
        headers: { cookie: `DEVICE_TOKEN=${outsider.token}` },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe(
        'DEVICE_NOT_IN_SESSION_ROOM',
      );
    });

    it('grants SEND_AUDIO + RECEIVE_TRANSCRIPTIONS to the source device', async () => {
      // Arrange
      const { token, sessionUid } = await setupActiveSession();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/exchange-device-token`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        sessionToken: string;
        sessionTokenExpiresAt: string;
        scopes: string[];
      }>();
      expect(body.sessionToken).toEqual(expect.any(String));
      expect(body.sessionTokenExpiresAt).toEqual(expect.any(String));
      expect(body.scopes.sort()).toStrictEqual(
        ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'].sort(),
      );
    });

    it('grants only RECEIVE_TRANSCRIPTIONS to a non-source room member', async () => {
      // Arrange
      const { sessionUid, roomUid } = await setupActiveSession();
      const member = await setupActivatedDevice('Member');
      await addDeviceToRoom(roomUid, member.deviceUid);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/exchange-device-token`,
        headers: { cookie: `DEVICE_TOKEN=${member.token}` },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ scopes: string[] }>().scopes).toStrictEqual([
        'RECEIVE_TRANSCRIPTIONS',
      ]);
    });

    it('does not return a refresh token (device cookie is the persistent credential)', async () => {
      // Arrange
      const { token, sessionUid } = await setupActiveSession();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/exchange-device-token`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const body = res.json<Record<string, unknown>>();
      expect(body).not.toHaveProperty('sessionRefreshToken');
    });

    it('returns 409 when the session has not yet started', async () => {
      // Arrange - set scheduled_start_time well in the future to simulate
      // a not-yet-active session. Easier than setting up a SCHEDULED session.
      const { token, sessionUid } = await setupActiveSession();
      await dbContext.db
        .updateTable('sessions')
        .set({
          scheduled_start_time: new Date(Date.now() + 60 * 60 * 1000),
          scheduled_end_time: new Date(Date.now() + 2 * 60 * 60 * 1000),
        })
        .where('uid', '=', sessionUid)
        .execute();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/exchange-device-token`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe(
        'SESSION_NOT_CURRENTLY_ACTIVE',
      );
    });
  });

  describe('POST /exchange-join-code', (it) => {
    async function fetchJoinCode(token: string, sessionUid: string) {
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/fetch-join-code`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
        body: { sessionUid },
      });
      return res.json<{ current: { joinCode: string } }>().current.joinCode;
    }

    it('returns 404 when the join code is unknown', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/exchange-join-code`,
        body: { joinCode: 'NOPE0000' },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('JOIN_CODE_NOT_FOUND');
    });

    it('returns 410 when the join code has expired', async () => {
      // Arrange - issue a code, then back-date both valid_start and valid_end
      // so the row is expired. valid_end > valid_start is enforced by a
      // CHECK constraint, so we have to move both at once.
      const { token, sessionUid } = await setupActiveSession();
      const joinCode = await fetchJoinCode(token, sessionUid);
      const past = Date.now() - 60_000;
      await dbContext.db
        .updateTable('session_join_codes')
        .set({
          valid_start: new Date(past - 1000),
          valid_end: new Date(past),
        })
        .where('join_code', '=', joinCode)
        .execute();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/exchange-join-code`,
        body: { joinCode },
      });

      // Assert
      expect(res.statusCode).toBe(410);
      expect(res.json<{ code: string }>().code).toBe('JOIN_CODE_EXPIRED');
    });

    it('returns 409 when the session has been ended', async () => {
      // Arrange
      const { token, sessionUid } = await setupActiveSession();
      const joinCode = await fetchJoinCode(token, sessionUid);
      await endSessionEarly(sessionUid);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/exchange-join-code`,
        body: { joinCode },
      });

      // Assert
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe(
        'SESSION_NOT_CURRENTLY_ACTIVE',
      );
    });

    it('returns 200 with a session token, refresh token, clientId, and scopes', async () => {
      // Arrange
      const { token, sessionUid } = await setupActiveSession({
        joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
      });
      const joinCode = await fetchJoinCode(token, sessionUid);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/exchange-join-code`,
        body: { joinCode },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        sessionUid: string;
        clientId: string;
        sessionToken: string;
        sessionTokenExpiresAt: string;
        sessionRefreshToken: string;
        scopes: string[];
      }>();
      expect(body.sessionUid).toBe(sessionUid);
      expect(body.clientId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(body.sessionRefreshToken).toMatch(/^.+:.+/);
      expect(body.scopes).toStrictEqual(['RECEIVE_TRANSCRIPTIONS']);
    });

    it('persists exactly one refresh token per exchange', async () => {
      // Arrange
      const { token, sessionUid } = await setupActiveSession();
      const joinCode = await fetchJoinCode(token, sessionUid);

      // Act
      await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/exchange-join-code`,
        body: { joinCode },
      });
      await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/exchange-join-code`,
        body: { joinCode },
      });

      // Assert
      const tokens = await dbContext.db
        .selectFrom('session_refresh_tokens')
        .selectAll()
        .where('session_uid', '=', sessionUid)
        .execute();
      expect(tokens).toHaveLength(2);
      expect(tokens.every((t) => t.auth_method === 'JOIN_CODE')).toBe(true);
    });
  });

  describe('POST /refresh-session-token', (it) => {
    async function exchangeJoinCodeForRefresh(
      token: string,
      sessionUid: string,
    ) {
      const fetchRes = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/fetch-join-code`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
        body: { sessionUid },
      });
      const joinCode = fetchRes.json<{ current: { joinCode: string } }>()
        .current.joinCode;

      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/exchange-join-code`,
        body: { joinCode },
      });
      return res.json<{ sessionRefreshToken: string }>().sessionRefreshToken;
    }

    it('returns 401 when the refresh token is malformed (no separator)', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/refresh-session-token`,
        body: { sessionRefreshToken: 'no-separator' },
      });

      // Assert
      expect(res.statusCode).toBe(401);
      expect(res.json<{ code: string }>().code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('returns 401 when the refresh secret does not match the stored hash', async () => {
      // Arrange
      const { token, sessionUid } = await setupActiveSession();
      const refresh = await exchangeJoinCodeForRefresh(token, sessionUid);
      const tampered = `${refresh.split(':')[0]}:wrong-secret`;

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/refresh-session-token`,
        body: { sessionRefreshToken: tampered },
      });

      // Assert
      expect(res.statusCode).toBe(401);
      expect(res.json<{ code: string }>().code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('returns 409 when the session has been ended', async () => {
      // Arrange
      const { token, sessionUid } = await setupActiveSession();
      const refresh = await exchangeJoinCodeForRefresh(token, sessionUid);
      await endSessionEarly(sessionUid);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/refresh-session-token`,
        body: { sessionRefreshToken: refresh },
      });

      // Assert
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('SESSION_ENDED');
    });

    it('returns 200 with a fresh session token', async () => {
      // Arrange
      const { token, sessionUid } = await setupActiveSession();
      const refresh = await exchangeJoinCodeForRefresh(token, sessionUid);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/refresh-session-token`,
        body: { sessionRefreshToken: refresh },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        sessionToken: string;
        sessionTokenExpiresAt: string;
      }>();
      expect(body.sessionToken).toEqual(expect.any(String));
      expect(body.sessionTokenExpiresAt).toEqual(expect.any(String));
    });
  });
});
