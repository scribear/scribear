import { describe, expect } from 'vitest';

import type { SessionScope } from '@scribear/scribear-db';

import createServer from '#src/server/create-server.js';
import { useDb } from '#tests/utils/use-db.js';
import {
  ADMIN_HEADER,
  TEST_ADMIN_KEY,
  buildTestAppConfig,
  useServer,
} from '#tests/utils/use-server.js';

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

  async function createRoomWithSource(
    sourceDeviceUid: string,
    autoSessionEnabled = false,
  ) {
    const res = await server.fastify.inject({
      method: 'POST',
      url: `${ROOM_BASE}/create-room`,
      headers: { authorization: ADMIN_HEADER },
      body: {
        name: 'Test Room',
        timezone: 'America/New_York',
        autoSessionEnabled,
        sourceDeviceUids: [sourceDeviceUid],
      },
    });
    return res.json<{ uid: string }>().uid;
  }

  /**
   * Gives a room an auto-session window that is open right now: every day of
   * the week, all day, active since 2020.
   *
   * Every other fixture in this file uses `autoSessionEnabled: false`, which
   * short-circuits the auto-session reconciler before it does anything - so
   * none of them exercise the interaction between a standing on-demand
   * session and a materialized AUTO slot. That gap is not hypothetical: a 500
   * that broke on-demand sessions in *every* auto-enabled room once survived
   * the entire integration suite, because no fixture was ever live at the
   * moment the suite ran.
   */
  async function enableLiveAutoSessionWindow(roomUid: string) {
    const res = await server.fastify.inject({
      method: 'POST',
      url: `${SCHEDULE_BASE}/create-auto-session-window`,
      headers: { authorization: ADMIN_HEADER },
      body: {
        roomUid,
        localStartTime: '00:00:00',
        localEndTime: '23:59:59',
        daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'],
        activeStart: '2020-01-01T00:00:00.000Z',
        activeEnd: null,
        joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      },
    });
    // Asserted, not assumed: a fixture that quietly 400s would leave the room
    // with no live window at all, and every test built on it would pass while
    // exercising precisely the path it was written to cover.
    expect(res.statusCode).toBe(201);
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

  /**
   * Builds an in-room source device + a **SCHEDULED** session whose effective
   * window covers now. `cancel-session` only accepts SCHEDULED occurrences, so
   * this is the only shape that can reach the canceled-but-live state the auth
   * paths have to defend against.
   */
  async function setupLiveScheduledSession(opts: CreateSessionOpts = {}) {
    const source = await setupActivatedDevice('Source Device');
    const roomUid = await createRoomWithSource(source.deviceUid);
    const schedule = await dbContext.db
      .insertInto('session_schedules')
      .values({
        room_uid: roomUid,
        name: 'S',
        active_start: new Date('2024-01-01T00:00:00Z'),
        active_end: null,
        anchor_start: new Date('2024-01-01T00:00:00Z'),
        local_start_time: '09:00:00',
        local_end_time: '10:00:00',
        frequency: 'ONCE',
        days_of_week: null,
        transcription_provider_id: 'whisper',
        transcription_stream_config: {},
      })
      .returning('uid')
      .executeTakeFirstOrThrow();
    const session = await dbContext.db
      .insertInto('sessions')
      .values({
        room_uid: roomUid,
        name: 'Scheduled',
        type: 'SCHEDULED',
        scheduled_session_uid: schedule.uid,
        scheduled_start_time: new Date(Date.now() - 60 * 60 * 1000),
        scheduled_end_time: new Date(Date.now() + 60 * 60 * 1000),
        join_code_scopes: (opts.joinCodeScopes ?? [
          'RECEIVE_TRANSCRIPTIONS',
        ]) as SessionScope[],
        transcription_provider_id: 'whisper',
        transcription_stream_config: {},
      })
      .returning('uid')
      .executeTakeFirstOrThrow();
    return { ...source, roomUid, sessionUid: session.uid };
  }

  /**
   * Cancels a currently-live SCHEDULED session through the real
   * `cancel-session` endpoint, then restores its window.
   *
   * The detour exists because `assertCancelable` requires the occurrence to
   * still be upcoming - which is exactly why the bug this guards is reachable:
   * an operator cancels a future occurrence, time passes, and the row's
   * effective window ends up covering now while `canceled_at` stays set. We
   * push the window forward to satisfy the endpoint's precondition, cancel for
   * real, then put the window back to simulate that passage of time. Nothing
   * about the resulting row is synthesized by the test.
   */
  async function cancelLiveScheduledSession(sessionUid: string) {
    const original = await dbContext.db
      .selectFrom('sessions')
      .select(['scheduled_start_time', 'scheduled_end_time'])
      .where('uid', '=', sessionUid)
      .executeTakeFirstOrThrow();

    await dbContext.db
      .updateTable('sessions')
      .set({
        scheduled_start_time: new Date(Date.now() + 60 * 60 * 1000),
        scheduled_end_time: new Date(Date.now() + 2 * 60 * 60 * 1000),
      })
      .where('uid', '=', sessionUid)
      .execute();

    const res = await server.fastify.inject({
      method: 'POST',
      url: `${SCHEDULE_BASE}/cancel-session`,
      headers: { authorization: ADMIN_HEADER },
      body: { sessionUid },
    });
    // Asserted, not assumed: a fixture that quietly 422s would leave the row
    // uncanceled and every test built on it would pass while proving nothing.
    expect(res.statusCode).toBe(200);
    expect(res.json<{ canceledAt: string | null }>().canceledAt).toEqual(
      expect.any(String),
    );

    await dbContext.db
      .updateTable('sessions')
      .set({
        scheduled_start_time: original.scheduled_start_time,
        scheduled_end_time: original.scheduled_end_time,
      })
      .where('uid', '=', sessionUid)
      .execute();
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

    it('returns 404 for a canceled session whose window covers now', async () => {
      // Arrange
      const { token, sessionUid } = await setupLiveScheduledSession();
      await cancelLiveScheduledSession(sessionUid);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/fetch-join-code`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('SESSION_NOT_FOUND');
      // No code may be minted either: a code outlives this request and would
      // still be exchangeable from anywhere.
      const codes = await dbContext.db
        .selectFrom('session_join_codes')
        .select('join_code')
        .where('session_uid', '=', sessionUid)
        .execute();
      expect(codes).toHaveLength(0);
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

  describe('POST /admin-fetch-join-code', (it) => {
    it('returns 401 when the admin key header is missing entirely', async () => {
      // Arrange - the header is Type.Optional in the schema precisely so that
      // adminApiKeyHook, not request validation, decides this. It used to answer
      // 400 VALIDATION_ERROR, which made "you sent no credential" and "you sent
      // the wrong credential" two different alerts for one problem.
      const { sessionUid } = await setupActiveSession();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/admin-fetch-join-code`,
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(401);
      expect(res.json<{ code: string }>().code).toBe('INVALID_ADMIN_KEY');
    });

    it('returns 401, not 400, for a base64-shaped admin key', async () => {
      // Arrange - `openssl rand -base64 32` emits `+`, `/` and `=`. The old
      // `^Bearer [A-Za-z0-9_-]+$` pattern rejected those during validation, so a
      // deployment whose ADMIN_API_KEY was generated that way got 400
      // VALIDATION_ERROR even when the key was correct.
      const { sessionUid } = await setupActiveSession();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/admin-fetch-join-code`,
        headers: { authorization: 'Bearer abc+def/ghi=' },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(401);
      expect(res.json<{ code: string }>().code).toBe('INVALID_ADMIN_KEY');
    });

    it('returns 401 when the header is not a Bearer credential at all', async () => {
      // Arrange - no `Bearer ` prefix. AdminAuthService.isValid rejects this on
      // its own, so dropping the schema pattern did not create a gap; it only
      // moved the answer from 400 to 401.
      const { sessionUid } = await setupActiveSession();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/admin-fetch-join-code`,
        headers: { authorization: TEST_ADMIN_KEY },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(401);
      expect(res.json<{ code: string }>().code).toBe('INVALID_ADMIN_KEY');
    });

    it('returns 200 for a correct admin key containing base64 characters', async () => {
      // Arrange - the invariant the pattern removal exists for: a *correct* key
      // authenticates whatever its encoding. Boots a second server whose
      // ADMIN_API_KEY is base64-shaped, since the shared one is not.
      const base64Key = Buffer.from(
        'admin-key-with-base64-shape-0123',
        'utf8',
      ).toString('base64');
      expect(base64Key).toMatch(/[+/=]/);
      const { fastify } = await createServer(
        buildTestAppConfig({ adminAuthConfig: { adminApiKey: base64Key } }),
      );
      await fastify.ready();

      try {
        const { sessionUid } = await setupActiveSession();

        // Act
        const res = await fastify.inject({
          method: 'POST',
          url: `${SESSION_AUTH_BASE}/admin-fetch-join-code`,
          headers: { authorization: `Bearer ${base64Key}` },
          body: { sessionUid },
        });

        // Assert
        expect(res.statusCode).toBe(200);
      } finally {
        await fastify.close();
      }
    });

    it('returns 401 when the admin key is wrong', async () => {
      // Arrange
      const { sessionUid } = await setupActiveSession();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/admin-fetch-join-code`,
        headers: { authorization: 'Bearer wrong-key' },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when the session does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/admin-fetch-join-code`,
        headers: { authorization: ADMIN_HEADER },
        body: { sessionUid: NULL_UUID },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('SESSION_NOT_FOUND');
    });

    it("returns status 'no-join-scopes' when the session has empty joinCodeScopes", async () => {
      // Arrange
      const { sessionUid } = await setupActiveSession({ joinCodeScopes: [] });

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/admin-fetch-join-code`,
        headers: { authorization: ADMIN_HEADER },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        status: string;
        joinCode: string | null;
        validEnd: string | null;
      }>();
      expect(body.status).toBe('no-join-scopes');
      expect(body.joinCode).toBeNull();
      expect(body.validEnd).toBeNull();
    });

    it("returns status 'not-active' when the session has not started", async () => {
      // Arrange
      const { sessionUid } = await setupActiveSession();
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
        url: `${SESSION_AUTH_BASE}/admin-fetch-join-code`,
        headers: { authorization: ADMIN_HEADER },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ status: string }>().status).toBe('not-active');
    });

    it("returns status 'not-active' when the session has ended", async () => {
      // Arrange
      const { sessionUid } = await setupActiveSession();
      await endSessionEarly(sessionUid);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/admin-fetch-join-code`,
        headers: { authorization: ADMIN_HEADER },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ status: string }>().status).toBe('not-active');
    });

    it("returns status 'not-active' for a canceled session whose window covers now", async () => {
      // Arrange
      const { sessionUid } = await setupLiveScheduledSession();
      await cancelLiveScheduledSession(sessionUid);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/admin-fetch-join-code`,
        headers: { authorization: ADMIN_HEADER },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ status: string }>().status).toBe('not-active');
      expect(res.json<{ joinCode: string | null }>().joinCode).toBeNull();
    });

    it("returns status 'ok' with a fresh code on the first call", async () => {
      // Arrange
      const { sessionUid } = await setupActiveSession();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/admin-fetch-join-code`,
        headers: { authorization: ADMIN_HEADER },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        status: string;
        joinCode: string | null;
        validEnd: string | null;
      }>();
      expect(body.status).toBe('ok');
      expect(body.joinCode).toMatch(/^[A-Z0-9]{8}$/);
      expect(body.validEnd).toEqual(expect.any(String));
    });

    it('is idempotent across repeated calls within the code lifetime', async () => {
      // Arrange
      const { sessionUid } = await setupActiveSession();
      const first = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/admin-fetch-join-code`,
        headers: { authorization: ADMIN_HEADER },
        body: { sessionUid },
      });

      // Act
      const second = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/admin-fetch-join-code`,
        headers: { authorization: ADMIN_HEADER },
        body: { sessionUid },
      });

      // Assert
      const firstBody = first.json<{ joinCode: string }>();
      const secondBody = second.json<{ joinCode: string }>();
      expect(secondBody.joinCode).toBe(firstBody.joinCode);
    });

    it('mints the same current code a device would get from fetch-join-code', async () => {
      // Arrange - the admin route and the device route must agree, since the
      // console's link has to actually work for a device that later joins.
      const { token, sessionUid } = await setupActiveSession();

      // Act
      const adminRes = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/admin-fetch-join-code`,
        headers: { authorization: ADMIN_HEADER },
        body: { sessionUid },
      });
      const deviceRes = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/fetch-join-code`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
        body: { sessionUid },
      });

      // Assert
      const adminCode = adminRes.json<{ joinCode: string }>().joinCode;
      const deviceCode = deviceRes.json<{ current: { joinCode: string } }>()
        .current.joinCode;
      expect(adminCode).toBe(deviceCode);
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

    it('grants the source device its scopes in a room whose auto-session window is live now', async () => {
      // Arrange - the same happy path as above, but in a room that has
      // auto-sessions enabled *and* a window open at this moment, so the
      // auto-session reconciler actually runs against a standing on-demand
      // session rather than short-circuiting. Every other fixture here is
      // auto-disabled, which is how a 500 on this exact combination once
      // survived the whole suite.
      const source = await setupActivatedDevice('Source Device');
      const roomUid = await createRoomWithSource(source.deviceUid, true);
      await enableLiveAutoSessionWindow(roomUid);
      const sessionUid = await createOnDemandSession(roomUid);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/exchange-device-token`,
        headers: { cookie: `DEVICE_TOKEN=${source.token}` },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const body = res.json<{ sessionToken: string; scopes: string[] }>();
      expect(body.sessionToken).toEqual(expect.any(String));
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

    it('returns 409 for a canceled session whose window covers now', async () => {
      // Arrange - the source kiosk still has this uid cached from before the
      // cancellation; without the guard it re-arms itself with a SEND_AUDIO
      // token and streams into a session nobody scheduled.
      const { token, sessionUid } = await setupLiveScheduledSession();
      await cancelLiveScheduledSession(sessionUid);

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

    it('returns 404 for the pre-minted handoff code until its validStart arrives', async () => {
      // Arrange - drive the real handoff: back-date the current code so we are
      // inside the 60s handoff window, then re-fetch, which mints `next` with
      // validStart == current.validEnd. That code is in the future.
      const { token, sessionUid } = await setupActiveSession();
      const current = await fetchJoinCode(token, sessionUid);
      const now = Date.now();
      await dbContext.db
        .updateTable('session_join_codes')
        .set({
          valid_start: new Date(now - 4 * 60_000 - 30_000),
          valid_end: new Date(now + 30_000),
        })
        .where('join_code', '=', current)
        .execute();

      const pairRes = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/fetch-join-code`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
        body: { sessionUid },
      });
      const next = pairRes.json<{
        next: { joinCode: string; validStart: string } | null;
      }>().next;
      expect(next).not.toBeNull();
      expect(Date.parse(next!.validStart)).toBeGreaterThan(Date.now());

      // Act - the handoff code, presented early.
      const early = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/exchange-join-code`,
        body: { joinCode: next!.joinCode },
      });

      // Assert - not yet. Answering 404 rather than a distinct status also
      // keeps the route from confirming an unused code to anyone guessing.
      expect(early.statusCode).toBe(404);
      expect(early.json<{ code: string }>().code).toBe('JOIN_CODE_NOT_FOUND');

      // The current code is unaffected - the handoff still works.
      const stillCurrent = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/exchange-join-code`,
        body: { joinCode: current },
      });
      expect(stillCurrent.statusCode).toBe(200);

      // And the handoff code becomes exchangeable the moment its window opens.
      await dbContext.db
        .updateTable('session_join_codes')
        .set({ valid_start: new Date(Date.now() - 1000) })
        .where('join_code', '=', next!.joinCode)
        .execute();
      const onTime = await server.fastify.inject({
        method: 'POST',
        url: `${SESSION_AUTH_BASE}/exchange-join-code`,
        body: { joinCode: next!.joinCode },
      });
      expect(onTime.statusCode).toBe(200);
    });

    it('returns 409 for a canceled session, and mints nothing', async () => {
      // Arrange - the code was minted while the session was still live and is
      // well inside its 5-minute TTL, so the code row alone cannot stop this.
      const { token, sessionUid } = await setupLiveScheduledSession();
      const joinCode = await fetchJoinCode(token, sessionUid);
      await cancelLiveScheduledSession(sessionUid);

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
      // A refresh token would outlive the request and keep re-minting.
      const tokens = await dbContext.db
        .selectFrom('session_refresh_tokens')
        .select('uid')
        .where('session_uid', '=', sessionUid)
        .execute();
      expect(tokens).toHaveLength(0);
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
      const tampered = `${refresh.split(':')[0]!}:wrong-secret`;

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

    it('returns 409 when the session has been canceled', async () => {
      // Arrange - a viewer who joined before the cancellation holds a refresh
      // token that outlives every short-lived session token; cancellation has
      // to be terminal here or the viewer never actually loses access.
      const { token, sessionUid } = await setupLiveScheduledSession();
      const refresh = await exchangeJoinCodeForRefresh(token, sessionUid);
      await cancelLiveScheduledSession(sessionUid);

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
