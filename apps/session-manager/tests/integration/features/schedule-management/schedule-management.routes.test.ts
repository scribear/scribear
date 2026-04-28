import { describe, expect } from 'vitest';

import { useDb } from '#tests/utils/use-db.js';
import {
  ADMIN_HEADER,
  SERVICE_HEADER,
  useServer,
} from '#tests/utils/use-server.js';

const DEVICE_BASE = '/api/session-manager/v1/device-management';
const ROOM_BASE = '/api/session-manager/v1/room-management';
const SCHEDULE_BASE = '/api/session-manager/v1/schedule-management';
const NULL_UUID = '00000000-0000-0000-0000-000000000000';

describe('Schedule Management Routes', () => {
  const server = useServer();
  useDb([
    'sessions',
    'session_schedules',
    'auto_session_windows',
    'rooms',
    'devices',
  ]);

  async function registerDevice(name = 'Test Device') {
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

  async function setupActivatedDevice(name = 'Test Device') {
    const { deviceUid, activationCode } = await registerDevice(name);
    const token = await activateDevice(activationCode);
    return { deviceUid, token };
  }

  async function createRoom(deviceUid: string, name = 'Test Room') {
    const res = await server.fastify.inject({
      method: 'POST',
      url: `${ROOM_BASE}/create-room`,
      headers: { authorization: ADMIN_HEADER },
      body: {
        name,
        timezone: 'America/New_York',
        autoSessionEnabled: false,
        sourceDeviceUids: [deviceUid],
      },
    });
    return res.json<{ uid: string; roomScheduleVersion: number }>();
  }

  async function setupRoom(name = 'Test Room') {
    const { deviceUid, token } = await setupActivatedDevice(name);
    const room = await createRoom(deviceUid, name);
    return { deviceUid, token, roomUid: room.uid };
  }

  function defaultScheduleBody(roomUid: string, overrides: object = {}) {
    return {
      roomUid,
      name: 'Standup',
      activeStart: '2030-06-02T00:00:00.000Z',
      activeEnd: null,
      localStartTime: '14:00:00',
      localEndTime: '15:00:00',
      frequency: 'WEEKLY',
      daysOfWeek: ['MON', 'WED', 'FRI'],
      joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
      transcriptionProviderId: 'whisper',
      transcriptionStreamConfig: {},
      ...overrides,
    };
  }

  function defaultWindowBody(roomUid: string, overrides: object = {}) {
    return {
      roomUid,
      localStartTime: '09:00:00',
      localEndTime: '17:00:00',
      daysOfWeek: ['MON', 'TUE'],
      activeStart: '2030-06-02T00:00:00.000Z',
      activeEnd: null,
      transcriptionProviderId: 'whisper',
      transcriptionStreamConfig: {},
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  describe('admin key auth', (it) => {
    it('returns 401 when the admin API key is invalid', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-schedule`,
        headers: { authorization: 'Bearer wrong-key' },
        body: defaultScheduleBody(NULL_UUID),
      });

      // Assert
      expect(res.statusCode).toBe(401);
    });
  });

  describe('service key auth', (it) => {
    it('returns 401 when calling session-config-stream with the wrong key', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/session-config-stream/${NULL_UUID}?sinceVersion=0`,
        headers: { authorization: 'Bearer wrong-service-key' },
      });

      // Assert
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 when calling session-config-stream with the admin key', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/session-config-stream/${NULL_UUID}?sinceVersion=0`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Schedule CRUD
  // ---------------------------------------------------------------------------

  describe('POST /create-schedule', (it) => {
    it('returns 201 with the created schedule', async () => {
      // Arrange
      const { roomUid } = await setupRoom();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultScheduleBody(roomUid),
      });

      // Assert
      expect(res.statusCode).toBe(201);
      const body = res.json<{ uid: string; roomUid: string; name: string }>();
      expect(body.uid).toEqual(expect.any(String));
      expect(body.roomUid).toBe(roomUid);
      expect(body.name).toBe('Standup');
    });

    it('returns 404 when the room does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultScheduleBody(NULL_UUID),
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('ROOM_NOT_FOUND');
    });

    it('returns 409 when the schedule conflicts with an existing one', async () => {
      // Arrange
      const { roomUid } = await setupRoom();
      await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultScheduleBody(roomUid, { name: 'First' }),
      });

      // Act - same time + days overlaps the first one.
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultScheduleBody(roomUid, { name: 'Overlap' }),
      });

      // Assert
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('CONFLICT');
    });
  });

  describe('GET /get-schedule/:scheduleUid', (it) => {
    it('returns 200 with the schedule', async () => {
      // Arrange
      const { roomUid } = await setupRoom();
      const create = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultScheduleBody(roomUid),
      });
      const { uid: scheduleUid } = create.json<{ uid: string }>();

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/get-schedule/${scheduleUid}`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ uid: string }>().uid).toBe(scheduleUid);
    });

    it('returns 404 when the schedule does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/get-schedule/${NULL_UUID}`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('SCHEDULE_NOT_FOUND');
    });
  });

  describe('POST /update-schedule', (it) => {
    it('returns 200 with the new schedule, replacing the original', async () => {
      // Arrange
      const { roomUid } = await setupRoom();
      const create = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultScheduleBody(roomUid),
      });
      const { uid: scheduleUid } = create.json<{ uid: string }>();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/update-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: { scheduleUid, name: 'Renamed' },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const body = res.json<{ uid: string; name: string }>();
      expect(body.name).toBe('Renamed');
    });

    it('returns 404 when the schedule does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/update-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: { scheduleUid: NULL_UUID, name: 'X' },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('SCHEDULE_NOT_FOUND');
    });
  });

  describe('POST /delete-schedule', (it) => {
    it('returns 204 on success', async () => {
      // Arrange
      const { roomUid } = await setupRoom();
      const create = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultScheduleBody(roomUid),
      });
      const { uid: scheduleUid } = create.json<{ uid: string }>();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/delete-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: { scheduleUid },
      });

      // Assert
      expect(res.statusCode).toBe(204);
    });

    it('returns 404 when the schedule does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/delete-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: { scheduleUid: NULL_UUID },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('SCHEDULE_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // Auto-session window CRUD
  // ---------------------------------------------------------------------------

  describe('POST /create-auto-session-window', (it) => {
    it('returns 201 with the created window', async () => {
      // Arrange
      const { roomUid } = await setupRoom();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-auto-session-window`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultWindowBody(roomUid),
      });

      // Assert
      expect(res.statusCode).toBe(201);
      const body = res.json<{ uid: string; roomUid: string }>();
      expect(body.uid).toEqual(expect.any(String));
      expect(body.roomUid).toBe(roomUid);
    });

    it('returns 404 when the room does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-auto-session-window`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultWindowBody(NULL_UUID),
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('ROOM_NOT_FOUND');
    });

    it('returns 409 when the window conflicts with an existing one', async () => {
      // Arrange
      const { roomUid } = await setupRoom();
      await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-auto-session-window`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultWindowBody(roomUid),
      });

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-auto-session-window`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultWindowBody(roomUid),
      });

      // Assert
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('CONFLICT');
    });
  });

  describe('GET /get-auto-session-window/:windowUid', (it) => {
    it('returns 200 with the window', async () => {
      // Arrange
      const { roomUid } = await setupRoom();
      const create = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-auto-session-window`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultWindowBody(roomUid),
      });
      const { uid: windowUid } = create.json<{ uid: string }>();

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/get-auto-session-window/${windowUid}`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ uid: string }>().uid).toBe(windowUid);
    });

    it('returns 404 when the window does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/get-auto-session-window/${NULL_UUID}`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('WINDOW_NOT_FOUND');
    });
  });

  describe('POST /update-auto-session-window', (it) => {
    it('returns 200 with the new window, replacing the original', async () => {
      // Arrange
      const { roomUid } = await setupRoom();
      const create = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-auto-session-window`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultWindowBody(roomUid),
      });
      const { uid: windowUid } = create.json<{ uid: string }>();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/update-auto-session-window`,
        headers: { authorization: ADMIN_HEADER },
        body: { windowUid, localStartTime: '08:00:00' },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ localStartTime: string }>().localStartTime).toBe(
        '08:00:00',
      );
    });

    it('returns 404 when the window does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/update-auto-session-window`,
        headers: { authorization: ADMIN_HEADER },
        body: { windowUid: NULL_UUID, localStartTime: '08:00:00' },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('WINDOW_NOT_FOUND');
    });
  });

  describe('POST /delete-auto-session-window', (it) => {
    it('returns 204 on success', async () => {
      // Arrange
      const { roomUid } = await setupRoom();
      const create = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-auto-session-window`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultWindowBody(roomUid),
      });
      const { uid: windowUid } = create.json<{ uid: string }>();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/delete-auto-session-window`,
        headers: { authorization: ADMIN_HEADER },
        body: { windowUid },
      });

      // Assert
      expect(res.statusCode).toBe(204);
    });

    it('returns 404 when the window does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/delete-auto-session-window`,
        headers: { authorization: ADMIN_HEADER },
        body: { windowUid: NULL_UUID },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('WINDOW_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // Room schedule config
  // ---------------------------------------------------------------------------

  describe('POST /update-room-schedule-config', (it) => {
    it('returns 200 and toggles autoSessionEnabled', async () => {
      // Arrange
      const { roomUid } = await setupRoom();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/update-room-schedule-config`,
        headers: { authorization: ADMIN_HEADER },
        body: { roomUid, autoSessionEnabled: false },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ uid: string; autoSessionEnabled: boolean }>()).toMatchObject({
        uid: roomUid,
        autoSessionEnabled: false,
      });
    });

    it('returns 404 when the room does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/update-room-schedule-config`,
        headers: { authorization: ADMIN_HEADER },
        body: { roomUid: NULL_UUID, autoSessionEnabled: true },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('ROOM_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // Session operations
  // ---------------------------------------------------------------------------

  describe('GET /get-session/:sessionUid', (it) => {
    it('returns 200 with the session', async () => {
      // Arrange
      const { roomUid } = await setupRoom();
      const create = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-on-demand-session`,
        headers: { authorization: ADMIN_HEADER },
        body: {
          roomUid,
          name: 'Quick',
          joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
      });
      const { uid: sessionUid } = create.json<{ uid: string }>();

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/get-session/${sessionUid}`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ uid: string }>().uid).toBe(sessionUid);
    });

    it('returns 404 when the session does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/get-session/${NULL_UUID}`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('SESSION_NOT_FOUND');
    });
  });

  describe('POST /create-on-demand-session', (it) => {
    function makeBody(roomUid: string, overrides: object = {}) {
      return {
        roomUid,
        name: 'Quick Meeting',
        joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
        ...overrides,
      };
    }

    it('returns 201 with the created ON_DEMAND session', async () => {
      // Arrange
      const { roomUid } = await setupRoom();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-on-demand-session`,
        headers: { authorization: ADMIN_HEADER },
        body: makeBody(roomUid),
      });

      // Assert
      expect(res.statusCode).toBe(201);
      expect(res.json<{ type: string }>().type).toBe('ON_DEMAND');
    });

    it('returns 404 when the room does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-on-demand-session`,
        headers: { authorization: ADMIN_HEADER },
        body: makeBody(NULL_UUID),
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('ROOM_NOT_FOUND');
    });

    it('returns 409 when another non-AUTO session is already active', async () => {
      // Arrange
      const { roomUid } = await setupRoom();
      await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-on-demand-session`,
        headers: { authorization: ADMIN_HEADER },
        body: makeBody(roomUid, { name: 'First' }),
      });

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-on-demand-session`,
        headers: { authorization: ADMIN_HEADER },
        body: makeBody(roomUid, { name: 'Second' }),
      });

      // Assert
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('ANOTHER_SESSION_ACTIVE');
    });
  });

  describe('POST /end-session-early', (it) => {
    it('returns 200 and ends the active session', async () => {
      // Arrange
      const { roomUid } = await setupRoom();
      const create = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-on-demand-session`,
        headers: { authorization: ADMIN_HEADER },
        body: {
          roomUid,
          name: 'Quick',
          joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
      });
      const { uid: sessionUid } = create.json<{ uid: string }>();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/end-session-early`,
        headers: { authorization: ADMIN_HEADER },
        body: { sessionUid },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ endOverride: string | null }>().endOverride).toEqual(
        expect.any(String),
      );
    });

    it('returns 404 when the session does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/end-session-early`,
        headers: { authorization: ADMIN_HEADER },
        body: { sessionUid: NULL_UUID },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('SESSION_NOT_FOUND');
    });
  });

  describe('POST /start-session-early', (it) => {
    it('returns 404 when the session does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/start-session-early`,
        headers: { authorization: ADMIN_HEADER },
        body: { sessionUid: NULL_UUID },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('SESSION_NOT_FOUND');
    });
  });

  // ---------------------------------------------------------------------------
  // Long-poll: session-config-stream
  // ---------------------------------------------------------------------------

  describe('GET /session-config-stream/:sessionUid', (it) => {
    it('returns 200 immediately when the session config has advanced past sinceVersion', async () => {
      // Arrange
      const { roomUid } = await setupRoom();
      const create = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-on-demand-session`,
        headers: { authorization: ADMIN_HEADER },
        body: {
          roomUid,
          name: 'Quick',
          joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
      });
      const { uid: sessionUid } = create.json<{ uid: string }>();

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/session-config-stream/${sessionUid}?sinceVersion=0`,
        headers: { authorization: SERVICE_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ uid: string }>().uid).toBe(sessionUid);
    });

    it('returns 404 when the session does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/session-config-stream/${NULL_UUID}?sinceVersion=0`,
        headers: { authorization: SERVICE_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('SESSION_NOT_FOUND');
    });
  });
});
