import { describe, expect } from 'vitest';

import { useDb } from '#tests/utils/use-db.js';
import { ADMIN_HEADER, useServer } from '#tests/utils/use-server.js';

const DEVICE_BASE = '/api/session-manager/v1/device-management';
const ROOM_BASE = '/api/session-manager/v1/room-management';
const NULL_UUID = '00000000-0000-0000-0000-000000000000';

describe('Room Management Routes', () => {
  const server = useServer();
  useDb(['rooms', 'devices']);

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
      body: { name, timezone: 'America/New_York', sourceDeviceUids: [deviceUid] },
    });
    return res.json<{ uid: string; name: string }>();
  }

  describe('admin key auth', (it) => {
    it('returns 401 when the API key is invalid', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/create-room`,
        headers: { authorization: 'Bearer wrongkey' },
        body: { name: 'Room', timezone: 'UTC', sourceDeviceUids: [NULL_UUID] },
      });

      // Assert
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /create-room', (it) => {
    it('returns 201 with room data', async () => {
      // Arrange
      const { deviceUid } = await setupActivatedDevice();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/create-room`,
        headers: { authorization: ADMIN_HEADER },
        body: {
          name: 'My Room',
          timezone: 'America/New_York',
          sourceDeviceUids: [deviceUid],
        },
      });

      // Assert
      expect(res.statusCode).toBe(201);
      const body = res.json<{ uid: string; name: string; timezone: string }>();
      expect(body.uid).toEqual(expect.any(String));
      expect(body.name).toBe('My Room');
      expect(body.timezone).toBe('America/New_York');
    });

    it('returns 422 for an invalid timezone', async () => {
      // Arrange
      const { deviceUid } = await setupActivatedDevice();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/create-room`,
        headers: { authorization: ADMIN_HEADER },
        body: {
          name: 'My Room',
          timezone: 'Not/ATimezone',
          sourceDeviceUids: [deviceUid],
        },
      });

      // Assert
      expect(res.statusCode).toBe(422);
      expect(res.json<{ code: string }>().code).toBe('INVALID_TIMEZONE');
    });

    it('returns 404 when the source device does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/create-room`,
        headers: { authorization: ADMIN_HEADER },
        body: { name: 'Room', timezone: 'America/New_York', sourceDeviceUids: [NULL_UUID] },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('DEVICE_NOT_FOUND');
    });

    it('returns 409 when more than one source device is provided', async () => {
      // Arrange
      const { deviceUid: uid1 } = await setupActivatedDevice('Source-1');
      const { deviceUid: uid2 } = await setupActivatedDevice('Source-2');

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/create-room`,
        headers: { authorization: ADMIN_HEADER },
        body: { name: 'Room', timezone: 'America/New_York', sourceDeviceUids: [uid1, uid2] },
      });

      // Assert
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('TOO_MANY_SOURCE_DEVICES');
    });

    it('returns 409 when the source device is already in a room', async () => {
      // Arrange - activate a device and assign it to a room
      const { deviceUid } = await setupActivatedDevice();
      await createRoom(deviceUid);

      // Act - try to create a second room with the same device as source
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/create-room`,
        headers: { authorization: ADMIN_HEADER },
        body: { name: 'Another Room', timezone: 'America/New_York', sourceDeviceUids: [deviceUid] },
      });

      // Assert
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('DEVICE_ALREADY_IN_ROOM');
    });
  });

  describe('GET /list-rooms', (it) => {
    it('returns 200 with an items array containing created rooms', async () => {
      // Arrange
      const { deviceUid: d1 } = await setupActivatedDevice('D1');
      const { deviceUid: d2 } = await setupActivatedDevice('D2');
      await createRoom(d1, 'Room A');
      await createRoom(d2, 'Room B');

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${ROOM_BASE}/list-rooms`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ items: unknown[] }>().items).toHaveLength(2);
    });

    it('filters by search term (case-insensitive)', async () => {
      // Arrange
      const { deviceUid: d1 } = await setupActivatedDevice('D1');
      const { deviceUid: d2 } = await setupActivatedDevice('D2');
      await createRoom(d1, 'Alpha Room');
      await createRoom(d2, 'Beta Room');

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${ROOM_BASE}/list-rooms?search=alpha`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: { name: string }[] }>();
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.name).toBe('Alpha Room');
    });

    it('paginates results using limit and cursor', async () => {
      // Arrange
      const { deviceUid: d1 } = await setupActivatedDevice('D1');
      const { deviceUid: d2 } = await setupActivatedDevice('D2');
      const { deviceUid: d3 } = await setupActivatedDevice('D3');
      await createRoom(d1, 'Room A');
      await createRoom(d2, 'Room B');
      await createRoom(d3, 'Room C');

      // Act - first page
      const firstRes = await server.fastify.inject({
        method: 'GET',
        url: `${ROOM_BASE}/list-rooms?limit=2`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert - first page has 2 items and a cursor
      expect(firstRes.statusCode).toBe(200);
      const firstBody = firstRes.json<{ items: unknown[]; nextCursor?: string }>();
      expect(firstBody.items).toHaveLength(2);
      expect(firstBody.nextCursor).toBeDefined();

      // Act - second page
      const secondRes = await server.fastify.inject({
        method: 'GET',
        url: `${ROOM_BASE}/list-rooms?limit=2&cursor=${firstBody.nextCursor}`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert - second page has the remaining item and no cursor
      expect(secondRes.statusCode).toBe(200);
      const secondBody = secondRes.json<{ items: unknown[]; nextCursor?: string }>();
      expect(secondBody.items).toHaveLength(1);
      expect(secondBody.nextCursor).toBeUndefined();
    });
  });

  describe('GET /get-room/:roomUid', (it) => {
    it('returns 200 with room data', async () => {
      // Arrange
      const { deviceUid } = await setupActivatedDevice();
      const { uid: roomUid } = await createRoom(deviceUid, 'My Room');

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${ROOM_BASE}/get-room/${roomUid}`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ uid: string; name: string }>()).toMatchObject({
        uid: roomUid,
        name: 'My Room',
      });
    });

    it('returns 404 when the room does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${ROOM_BASE}/get-room/${NULL_UUID}`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('ROOM_NOT_FOUND');
    });
  });

  describe('POST /update-room', (it) => {
    it('returns 200 with the updated room', async () => {
      // Arrange
      const { deviceUid } = await setupActivatedDevice();
      const { uid: roomUid } = await createRoom(deviceUid, 'Old Name');

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/update-room`,
        headers: { authorization: ADMIN_HEADER },
        body: { roomUid, name: 'New Name' },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ name: string }>().name).toBe('New Name');
    });

    it('returns 404 when the room does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/update-room`,
        headers: { authorization: ADMIN_HEADER },
        body: { roomUid: NULL_UUID, name: 'X' },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('ROOM_NOT_FOUND');
    });

    it('returns 422 for an invalid timezone', async () => {
      // Arrange
      const { deviceUid } = await setupActivatedDevice();
      const { uid: roomUid } = await createRoom(deviceUid);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/update-room`,
        headers: { authorization: ADMIN_HEADER },
        body: { roomUid, timezone: 'Not/ATimezone' },
      });

      // Assert
      expect(res.statusCode).toBe(422);
      expect(res.json<{ code: string }>().code).toBe('INVALID_TIMEZONE');
    });
  });

  describe('POST /delete-room', (it) => {
    it('returns 204 on success', async () => {
      // Arrange
      const { deviceUid } = await setupActivatedDevice();
      const { uid: roomUid } = await createRoom(deviceUid);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/delete-room`,
        headers: { authorization: ADMIN_HEADER },
        body: { roomUid },
      });

      // Assert
      expect(res.statusCode).toBe(204);
    });

    it('returns 404 when the room does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/delete-room`,
        headers: { authorization: ADMIN_HEADER },
        body: { roomUid: NULL_UUID },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('ROOM_NOT_FOUND');
    });
  });

  describe('POST /add-device-to-room', (it) => {
    it('returns 204 when adding a device as a non-source member', async () => {
      // Arrange
      const { deviceUid: sourceUid } = await setupActivatedDevice('Source');
      const { uid: roomUid } = await createRoom(sourceUid);
      const { deviceUid: memberUid } = await registerDevice('Member');

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/add-device-to-room`,
        headers: { authorization: ADMIN_HEADER },
        body: { roomUid, deviceUid: memberUid },
      });

      // Assert
      expect(res.statusCode).toBe(204);
    });

    it('returns 404 when the room does not exist', async () => {
      // Arrange
      const { deviceUid } = await registerDevice();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/add-device-to-room`,
        headers: { authorization: ADMIN_HEADER },
        body: { roomUid: NULL_UUID, deviceUid },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('ROOM_NOT_FOUND');
    });

    it('returns 404 when the device does not exist', async () => {
      // Arrange
      const { deviceUid } = await setupActivatedDevice();
      const { uid: roomUid } = await createRoom(deviceUid);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/add-device-to-room`,
        headers: { authorization: ADMIN_HEADER },
        body: { roomUid, deviceUid: NULL_UUID },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('DEVICE_NOT_FOUND');
    });

    it('returns 409 when the device is already in a room', async () => {
      // Arrange
      const { deviceUid: sourceUid } = await setupActivatedDevice('Source');
      const { uid: roomUid } = await createRoom(sourceUid);

      // Act - sourceUid is already the source of the room
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/add-device-to-room`,
        headers: { authorization: ADMIN_HEADER },
        body: { roomUid, deviceUid: sourceUid },
      });

      // Assert
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('DEVICE_ALREADY_IN_ROOM');
    });
  });

  describe('POST /remove-device-from-room', (it) => {
    it('returns 204 when removing a non-source member', async () => {
      // Arrange
      const { deviceUid: sourceUid } = await setupActivatedDevice('Source');
      const { uid: roomUid } = await createRoom(sourceUid);
      const { deviceUid: memberUid } = await registerDevice('Member');
      await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/add-device-to-room`,
        headers: { authorization: ADMIN_HEADER },
        body: { roomUid, deviceUid: memberUid },
      });

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/remove-device-from-room`,
        headers: { authorization: ADMIN_HEADER },
        body: { deviceUid: memberUid },
      });

      // Assert
      expect(res.statusCode).toBe(204);
    });

    it('returns 404 when the device is not in any room', async () => {
      // Arrange
      const { deviceUid } = await registerDevice();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/remove-device-from-room`,
        headers: { authorization: ADMIN_HEADER },
        body: { deviceUid },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('MEMBERSHIP_NOT_FOUND');
    });

    it('returns 409 when removing the source would leave the room without one', async () => {
      // Arrange - sourceUid is the only member and it is the source
      const { deviceUid: sourceUid } = await setupActivatedDevice('Source');
      await createRoom(sourceUid);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/remove-device-from-room`,
        headers: { authorization: ADMIN_HEADER },
        body: { deviceUid: sourceUid },
      });

      // Assert
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('WOULD_LEAVE_ROOM_WITHOUT_SOURCE');
    });
  });

  describe('POST /set-source-device', (it) => {
    it('returns 204 and promotes the device to source', async () => {
      // Arrange
      const { deviceUid: sourceUid } = await setupActivatedDevice('Source');
      const { uid: roomUid } = await createRoom(sourceUid);
      const { deviceUid: memberUid } = await registerDevice('Member');
      await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/add-device-to-room`,
        headers: { authorization: ADMIN_HEADER },
        body: { roomUid, deviceUid: memberUid },
      });

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/set-source-device`,
        headers: { authorization: ADMIN_HEADER },
        body: { roomUid, deviceUid: memberUid },
      });

      // Assert
      expect(res.statusCode).toBe(204);
    });

    it('returns 404 when the room does not exist', async () => {
      // Arrange
      const { deviceUid } = await registerDevice();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/set-source-device`,
        headers: { authorization: ADMIN_HEADER },
        body: { roomUid: NULL_UUID, deviceUid },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('ROOM_NOT_FOUND');
    });

    it('returns 404 when the device is not a member of the room', async () => {
      // Arrange
      const { deviceUid: sourceUid } = await setupActivatedDevice('Source');
      const { uid: roomUid } = await createRoom(sourceUid);
      const { deviceUid: outsiderUid } = await registerDevice('Outsider');

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${ROOM_BASE}/set-source-device`,
        headers: { authorization: ADMIN_HEADER },
        body: { roomUid, deviceUid: outsiderUid },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('DEVICE_NOT_IN_ROOM');
    });
  });

  describe('GET /get-my-room', (it) => {
    it('returns 401 when the cookie is missing', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${ROOM_BASE}/get-my-room`,
      });

      // Assert
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 with room data when the device is a room member', async () => {
      // Arrange
      const { deviceUid, token } = await setupActivatedDevice();
      const { uid: roomUid } = await createRoom(deviceUid, 'My Room');

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${ROOM_BASE}/get-my-room`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ uid: string; name: string }>()).toMatchObject({
        uid: roomUid,
        name: 'My Room',
      });
    });

    it('returns 404 when the device is not in any room', async () => {
      // Arrange
      const { token } = await setupActivatedDevice();

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${ROOM_BASE}/get-my-room`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('DEVICE_NOT_IN_ROOM');
    });
  });
});
