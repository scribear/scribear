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
  const dbContext = useDb([
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

  describe('POST /create-schedule', (it) => {
    it('returns 422 when activeStart is in the past', async () => {
      // Arrange
      const { roomUid } = await setupRoom();

      // Act - supply a past activeStart.
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultScheduleBody(roomUid, {
          activeStart: '2020-01-01T00:00:00.000Z',
        }),
      });

      // Assert
      expect(res.statusCode).toBe(422);
      expect(res.json<{ code: string }>().code).toBe('INVALID_ACTIVE_START');
    });

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

  describe('GET /list-schedules', (it) => {
    it('returns 401 without credentials', async () => {
      // Arrange / Act - must supply a valid roomUid so schema validation passes
      // and the auth preHandler actually runs.
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/list-schedules?roomUid=${NULL_UUID}`,
        headers: { authorization: 'Bearer wrong-key' },
      });

      // Assert
      expect(res.statusCode).toBe(401);
    });

    it('returns 404 when the room does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/list-schedules?roomUid=${NULL_UUID}`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('ROOM_NOT_FOUND');
    });

    it('returns 200 with empty items when the room has no schedules', async () => {
      // Arrange
      const { roomUid } = await setupRoom();

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/list-schedules?roomUid=${roomUid}`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ items: unknown[] }>().items).toEqual([]);
    });

    it('returns all schedules when no time range is given', async () => {
      // Arrange
      const { roomUid } = await setupRoom();
      await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultScheduleBody(roomUid),
      });

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/list-schedules?roomUid=${roomUid}`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ items: unknown[] }>().items).toHaveLength(1);
    });

    it('includes schedules whose active range overlaps the requested window', async () => {
      // Arrange
      const { roomUid } = await setupRoom();
      await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultScheduleBody(roomUid, {
          activeStart: '2030-01-01T00:00:00.000Z',
          activeEnd: '2030-06-01T00:00:00.000Z',
        }),
      });

      // Act - range that overlaps the schedule's active window
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/list-schedules?roomUid=${roomUid}&from=2030-03-01T00:00:00.000Z&to=2030-09-01T00:00:00.000Z`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ items: unknown[] }>().items).toHaveLength(1);
    });

    it('excludes schedules whose active range does not overlap the requested window', async () => {
      // Arrange
      const { roomUid } = await setupRoom();
      await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultScheduleBody(roomUid, {
          activeStart: '2030-07-01T00:00:00.000Z',
          activeEnd: null,
        }),
      });

      // Act - to is before the schedule's activeStart
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/list-schedules?roomUid=${roomUid}&to=2030-06-01T00:00:00.000Z`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ items: unknown[] }>().items).toHaveLength(0);
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

    it('returns 422 when a past activeStart is supplied', async () => {
      // Arrange - create a far-future schedule, then update it to a past date.
      const { roomUid } = await setupRoom();
      const create = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultScheduleBody(roomUid),
      });
      const { uid: scheduleUid } = create.json<{ uid: string }>();

      // Act - supply an explicit past activeStart.
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/update-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: { scheduleUid, activeStart: '2020-01-01T00:00:00.000Z' },
      });

      // Assert
      expect(res.statusCode).toBe(422);
      expect(res.json<{ code: string }>().code).toBe('INVALID_ACTIVE_START');
    });

    it('preserves anchorStart when activeStart is bumped forward', async () => {
      // Arrange
      const { roomUid } = await setupRoom();
      const create = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultScheduleBody(roomUid),
      });
      const created = create.json<{ uid: string; anchorStart: string }>();

      // Act - change activeStart to a different far-future date.
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/update-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: {
          scheduleUid: created.uid,
          activeStart: '2031-01-01T00:00:00.000Z',
        },
      });

      // Assert - anchorStart in the response matches the original create.
      expect(res.statusCode).toBe(200);
      const updated = res.json<{ anchorStart: string }>();
      expect(updated.anchorStart).toBe(created.anchorStart);
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
      expect(
        res.json<{ uid: string; autoSessionEnabled: boolean }>(),
      ).toMatchObject({
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

    it('is a no-op and returns 200 when autoSessionEnabled is omitted', async () => {
      // Arrange
      const { roomUid } = await setupRoom();

      // Act - send only roomUid; service sees no change and skips the write.
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/update-room-schedule-config`,
        headers: { authorization: ADMIN_HEADER },
        body: { roomUid },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ uid: string }>().uid).toBe(roomUid);
    });
  });

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
    it('returns 200 and sets startOverride when the session is started early', async () => {
      // Arrange
      const { roomUid } = await setupRoom();
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const dayAfter = new Date(Date.now() + 48 * 60 * 60 * 1000);
      const [row] = await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Future Meeting',
          type: 'ON_DEMAND',
          scheduled_session_uid: null,
          scheduled_start_time: tomorrow,
          scheduled_end_time: dayAfter,
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .returning('uid')
        .execute();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/start-session-early`,
        headers: { authorization: ADMIN_HEADER },
        body: { sessionUid: row!.uid },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(
        res.json<{ uid: string; startOverride: string | null }>(),
      ).toMatchObject({
        uid: row!.uid,
        startOverride: expect.any(String),
      });
    });

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

  describe('GET /my-schedule', (it) => {
    it('returns 401 when the cookie is missing', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/my-schedule?sinceVersion=0`,
      });

      // Assert
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 with the room schedule when the version has advanced', async () => {
      // Arrange
      const { roomUid, token } = await setupRoom();

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/my-schedule?sinceVersion=0`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(
        res.json<{ roomUid: string; roomScheduleVersion: number }>(),
      ).toMatchObject({
        roomUid,
        roomScheduleVersion: expect.any(Number),
      });
    });

    it('returns 404 when the device is not in any room', async () => {
      // Arrange
      const { token } = await setupActivatedDevice();

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/my-schedule?sinceVersion=0`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('DEVICE_NOT_IN_ROOM');
    });
  });

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

  describe('long-poll wake-up via event bus', (it) => {
    /**
     * Returns once a subscription on `channelKey` is registered with the bus.
     * Times out at 1s; the test asserts the long-poll handler subscribed and
     * we don't want to race ahead to the mutation before the listener exists.
     */
    async function waitForSubscriber(
      channelKey: string,
      timeoutMs = 1000,
    ): Promise<void> {
      const eventBus = server.fastify.diContainer.resolve(
        'eventBusService',
      ) as unknown as { _channels: Map<string, Set<unknown>> };
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const subs = eventBus._channels.get(channelKey);
        if (subs && subs.size > 0) return;
        await new Promise((r) => setImmediate(r));
      }
      throw new Error(
        `timed out waiting for subscriber on channel ${channelKey}`,
      );
    }

    it('GET /my-schedule wakes up immediately when a schedule is created in the room', async () => {
      // Arrange - device + room; capture the room's current schedule version
      // so we know what to long-poll past.
      const { roomUid, token } = await setupRoom();
      const initial = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/my-schedule?sinceVersion=0`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
      });
      const initialVersion = initial.json<{ roomScheduleVersion: number }>()
        .roomScheduleVersion;

      // Act - start the long-poll without awaiting it; wait for the bus
      // subscription to be in place; trigger a mutation that bumps the room
      // version.
      const longPoll = server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/my-schedule?sinceVersion=${initialVersion}`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
      });
      await waitForSubscriber(`room-schedule-version-bumped:${roomUid}`);
      const startMs = Date.now();
      const create = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultScheduleBody(roomUid, { name: 'Wake' }),
      });
      expect(create.statusCode).toBe(201);
      const res = await longPoll;
      const elapsed = Date.now() - startMs;

      // Assert - long-poll resolved with the bumped version, well under the
      // 25 s server timeout.
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        roomUid: string;
        roomScheduleVersion: number;
        sessions: unknown[];
      }>();
      expect(body.roomUid).toBe(roomUid);
      expect(body.roomScheduleVersion).toBeGreaterThan(initialVersion);
      expect(elapsed).toBeLessThan(2000);
    });

    it('GET /session-config-stream wakes up immediately when the session is ended early', async () => {
      // Arrange - room + on-demand session; capture its config version.
      const { roomUid } = await setupRoom();
      const create = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-on-demand-session`,
        headers: { authorization: ADMIN_HEADER },
        body: {
          roomUid,
          name: 'WakeOD',
          joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
      });
      expect(create.statusCode).toBe(201);
      const session = create.json<{ uid: string; sessionConfigVersion: number }>();

      // Act - start the long-poll, wait for subscription, end the session.
      const longPoll = server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/session-config-stream/${session.uid}?sinceVersion=${session.sessionConfigVersion}`,
        headers: { authorization: SERVICE_HEADER },
      });
      await waitForSubscriber(
        `session-config-version-bumped:${session.uid}`,
      );
      const startMs = Date.now();
      const end = await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/end-session-early`,
        headers: { authorization: ADMIN_HEADER },
        body: { sessionUid: session.uid },
      });
      expect(end.statusCode).toBe(200);
      const res = await longPoll;
      const elapsed = Date.now() - startMs;

      // Assert
      expect(res.statusCode).toBe(200);
      const body = res.json<{ uid: string; sessionConfigVersion: number }>();
      expect(body.uid).toBe(session.uid);
      expect(body.sessionConfigVersion).toBeGreaterThan(
        session.sessionConfigVersion,
      );
      expect(elapsed).toBeLessThan(2000);
    });

    it('GET /my-schedule does not wake up for events on a different room', async () => {
      // Arrange - two rooms with separate devices.
      const roomA = await setupRoom('Room A');
      const roomB = await setupRoom('Room B');
      const initialA = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/my-schedule?sinceVersion=0`,
        headers: { cookie: `DEVICE_TOKEN=${roomA.token}` },
      });
      const initialAVersion = initialA.json<{ roomScheduleVersion: number }>()
        .roomScheduleVersion;

      // Act - long-poll Room A, mutate Room B; A must NOT resolve.
      const longPollA = server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/my-schedule?sinceVersion=${initialAVersion}`,
        headers: { cookie: `DEVICE_TOKEN=${roomA.token}` },
      });
      await waitForSubscriber(`room-schedule-version-bumped:${roomA.roomUid}`);
      await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultScheduleBody(roomB.roomUid, { name: 'OtherRoom' }),
      });

      // Race A's long-poll against a 200 ms timer; the timer must win because
      // the bus key includes the room UID and Room B's bump uses a different
      // key.
      const winner = await Promise.race([
        longPollA.then(() => 'longpoll' as const),
        new Promise<'timer'>((r) => setTimeout(() => r('timer'), 200)),
      ]);

      // Assert - A is still hanging.
      expect(winner).toBe('timer');

      // Cleanup - mutate Room A so the long-poll resolves and the test
      // doesn't leave a dangling subscription on the bus.
      await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultScheduleBody(roomA.roomUid, { name: 'WakeA' }),
      });
      await longPollA;
    });

    it('event bus subscriber set is empty after the long-poll resolves', async () => {
      // Arrange - room + initial state.
      const { roomUid, token } = await setupRoom();
      const initial = await server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/my-schedule?sinceVersion=0`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
      });
      const initialVersion = initial.json<{ roomScheduleVersion: number }>()
        .roomScheduleVersion;
      const eventBus = server.fastify.diContainer.resolve(
        'eventBusService',
      ) as unknown as { _channels: Map<string, Set<unknown>> };
      const channelKey = `room-schedule-version-bumped:${roomUid}`;

      // Act - long-poll, wait for subscription, mutate, await resolution.
      const longPoll = server.fastify.inject({
        method: 'GET',
        url: `${SCHEDULE_BASE}/my-schedule?sinceVersion=${initialVersion}`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
      });
      await waitForSubscriber(channelKey);
      expect(eventBus._channels.get(channelKey)?.size).toBe(1);
      await server.fastify.inject({
        method: 'POST',
        url: `${SCHEDULE_BASE}/create-schedule`,
        headers: { authorization: ADMIN_HEADER },
        body: defaultScheduleBody(roomUid, { name: 'CleanupCheck' }),
      });
      await longPoll;

      // Assert - bus removed the listener; map entry is gone (Set went empty).
      expect(eventBus._channels.get(channelKey)).toBeUndefined();
    });
  });
});
