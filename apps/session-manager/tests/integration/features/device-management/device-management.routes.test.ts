import { describe, expect } from 'vitest';

import { useDb } from '#tests/utils/use-db.js';
import { ADMIN_HEADER, useServer } from '#tests/utils/use-server.js';

const BASE = '/api/session-manager/v1/device-management';
const NULL_UUID = '00000000-0000-0000-0000-000000000000';

describe('Device Management Routes', () => {
  const server = useServer();
  const dbContext = useDb(['rooms', 'devices']);

  async function registerDevice(name = 'Test Device') {
    const res = await server.fastify.inject({
      method: 'POST',
      url: `${BASE}/register-device`,
      headers: { authorization: ADMIN_HEADER },
      body: { name },
    });
    return res.json<{ deviceUid: string; activationCode: string; expiry: string }>();
  }

  async function activateDevice(activationCode: string) {
    return server.fastify.inject({
      method: 'POST',
      url: `${BASE}/activate-device`,
      body: { activationCode },
    });
  }

  function extractDeviceToken(res: {
    headers: Record<string, unknown>;
  }): string {
    const setCookie = res.headers['set-cookie'];
    const raw = (Array.isArray(setCookie) ? setCookie[0] : setCookie) ?? '';
    const nameValue = `${raw}`.split(';')[0]!;
    return nameValue.slice(nameValue.indexOf('=') + 1);
  }

  describe('admin key auth', (it) => {
    it('returns 401 when the API key is invalid', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/register-device`,
        headers: { authorization: 'Bearer wrongkey' },
        body: { name: 'Device' },
      });

      // Assert
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /register-device', (it) => {
    it('returns 201 with deviceUid, activationCode, and expiry', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/register-device`,
        headers: { authorization: ADMIN_HEADER },
        body: { name: 'My Device' },
      });

      // Assert
      expect(res.statusCode).toBe(201);
      const body = res.json<{ deviceUid: string; activationCode: string; expiry: string }>();
      expect(body.deviceUid).toEqual(expect.any(String));
      expect(body.activationCode).toEqual(expect.any(String));
      expect(body.expiry).toEqual(expect.any(String));
    });
  });

  describe('POST /activate-device', (it) => {
    it('returns 200 with deviceUid and sets DEVICE_TOKEN cookie on success', async () => {
      // Arrange
      const { deviceUid, activationCode } = await registerDevice();

      // Act
      const res = await activateDevice(activationCode);

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ deviceUid: string }>().deviceUid).toBe(deviceUid);
      expect(res.headers['set-cookie']).toEqual(
        expect.stringContaining('DEVICE_TOKEN='),
      );
    });

    it('returns 404 when the activation code does not exist', async () => {
      // Arrange / Act
      const res = await activateDevice('NOTFOUND');

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('ACTIVATION_CODE_NOT_FOUND');
    });

    it('returns 410 when the activation code is expired', async () => {
      // Arrange
      await dbContext.db
        .insertInto('devices')
        .values({
          name: 'expired-device',
          activation_code: 'EXPIRED01',
          expiry: new Date(Date.now() - 1000),
        })
        .execute();

      // Act
      const res = await activateDevice('EXPIRED01');

      // Assert
      expect(res.statusCode).toBe(410);
      expect(res.json<{ code: string }>().code).toBe('ACTIVATION_CODE_EXPIRED');
    });
  });

  describe('GET /list-devices', (it) => {
    it('returns 200 with an items array containing registered devices', async () => {
      // Arrange
      await registerDevice('Device A');
      await registerDevice('Device B');

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/list-devices`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ items: unknown[] }>().items).toHaveLength(2);
    });

    it('filters by search term (case-insensitive)', async () => {
      // Arrange
      await registerDevice('Alpha Device');
      await registerDevice('Beta Device');

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/list-devices?search=alpha`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: { name: string }[] }>();
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.name).toBe('Alpha Device');
    });

    it('filters by roomUid and returns only devices in that room', async () => {
      // Arrange
      const { deviceUid: inRoomUid, activationCode } = await registerDevice('In-Room Device');
      await activateDevice(activationCode);
      const roomRes = await server.fastify.inject({
        method: 'POST',
        url: '/api/session-manager/v1/room-management/create-room',
        headers: { authorization: ADMIN_HEADER },
        body: { name: 'Test Room', timezone: 'America/New_York', sourceDeviceUids: [inRoomUid] },
      });
      const { uid: roomUid } = roomRes.json<{ uid: string }>();
      await registerDevice('Out-of-Room Device');

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/list-devices?roomUid=${roomUid}`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const body = res.json<{ items: { uid: string }[] }>();
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.uid).toBe(inRoomUid);
    });

    it('paginates results using limit and cursor', async () => {
      // Arrange
      await registerDevice('Device A');
      await registerDevice('Device B');
      await registerDevice('Device C');

      // Act - first page
      const firstRes = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/list-devices?limit=2`,
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
        url: `${BASE}/list-devices?limit=2&cursor=${firstBody.nextCursor}`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert - second page has the remaining item and no cursor
      expect(secondRes.statusCode).toBe(200);
      const secondBody = secondRes.json<{ items: unknown[]; nextCursor?: string }>();
      expect(secondBody.items).toHaveLength(1);
      expect(secondBody.nextCursor).toBeUndefined();
    });
  });

  describe('GET /get-device/:deviceUid', (it) => {
    it('returns 200 with device data', async () => {
      // Arrange
      const { deviceUid } = await registerDevice();

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/get-device/${deviceUid}`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ uid: string }>().uid).toBe(deviceUid);
    });

    it('returns 404 when the device does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/get-device/${NULL_UUID}`,
        headers: { authorization: ADMIN_HEADER },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('DEVICE_NOT_FOUND');
    });
  });

  describe('POST /reregister-device', (it) => {
    it('returns 200 with a new activationCode and expiry', async () => {
      // Arrange
      const { deviceUid, activationCode } = await registerDevice();
      await activateDevice(activationCode);

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/reregister-device`,
        headers: { authorization: ADMIN_HEADER },
        body: { deviceUid },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      const body = res.json<{ activationCode: string; expiry: string }>();
      expect(body.activationCode).toEqual(expect.any(String));
      expect(body.expiry).toEqual(expect.any(String));
    });

    it('returns 404 when the device does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/reregister-device`,
        headers: { authorization: ADMIN_HEADER },
        body: { deviceUid: NULL_UUID },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('DEVICE_NOT_FOUND');
    });
  });

  describe('POST /update-device', (it) => {
    it('returns 200 with the updated device', async () => {
      // Arrange
      const { deviceUid } = await registerDevice('Old Name');

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/update-device`,
        headers: { authorization: ADMIN_HEADER },
        body: { deviceUid, name: 'New Name' },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ name: string }>().name).toBe('New Name');
    });

    it('returns 404 when the device does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/update-device`,
        headers: { authorization: ADMIN_HEADER },
        body: { deviceUid: NULL_UUID, name: 'X' },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('DEVICE_NOT_FOUND');
    });
  });

  describe('POST /delete-device', (it) => {
    it('returns 204 on success', async () => {
      // Arrange
      const { deviceUid } = await registerDevice();

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/delete-device`,
        headers: { authorization: ADMIN_HEADER },
        body: { deviceUid },
      });

      // Assert
      expect(res.statusCode).toBe(204);
    });

    it('returns 404 when the device does not exist', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/delete-device`,
        headers: { authorization: ADMIN_HEADER },
        body: { deviceUid: NULL_UUID },
      });

      // Assert
      expect(res.statusCode).toBe(404);
      expect(res.json<{ code: string }>().code).toBe('DEVICE_NOT_FOUND');
    });

    it('returns 409 when the device is the source of a room', async () => {
      // Arrange
      const { deviceUid, activationCode } = await registerDevice('Source');
      await activateDevice(activationCode);
      await server.fastify.inject({
        method: 'POST',
        url: '/api/session-manager/v1/room-management/create-room',
        headers: { authorization: ADMIN_HEADER },
        body: { name: 'Room', timezone: 'America/New_York', sourceDeviceUids: [deviceUid] },
      });

      // Act
      const res = await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/delete-device`,
        headers: { authorization: ADMIN_HEADER },
        body: { deviceUid },
      });

      // Assert
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('WOULD_LEAVE_ROOM_WITHOUT_SOURCE');
    });
  });

  describe('GET /get-my-device', (it) => {
    it('returns 401 when the cookie is missing', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/get-my-device`,
      });

      // Assert
      expect(res.statusCode).toBe(401);
    });

    it('returns 200 with device data for an authenticated device', async () => {
      // Arrange
      const { deviceUid, activationCode } = await registerDevice();
      const activateRes = await activateDevice(activationCode);
      const token = extractDeviceToken(activateRes);

      // Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/get-my-device`,
        headers: { cookie: `DEVICE_TOKEN=${token}` },
      });

      // Assert
      expect(res.statusCode).toBe(200);
      expect(res.json<{ uid: string }>().uid).toBe(deviceUid);
    });

    it('returns 401 when the device token is invalid', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/get-my-device`,
        headers: { cookie: 'DEVICE_TOKEN=not-a-valid-token' },
      });

      // Assert
      expect(res.statusCode).toBe(401);
    });

    it('returns 401 when the device token has been revoked by re-registration', async () => {
      // Arrange - activate a device and capture the original token
      const { deviceUid, activationCode } = await registerDevice();
      const activateRes = await activateDevice(activationCode);
      const originalToken = extractDeviceToken(activateRes);

      // Re-register the device, which clears the stored hash
      await server.fastify.inject({
        method: 'POST',
        url: `${BASE}/reregister-device`,
        headers: { authorization: ADMIN_HEADER },
        body: { deviceUid },
      });

      // Act - present the now-stale token
      const res = await server.fastify.inject({
        method: 'GET',
        url: `${BASE}/get-my-device`,
        headers: { cookie: `DEVICE_TOKEN=${originalToken}` },
      });

      // Assert
      expect(res.statusCode).toBe(401);
    });
  });
});
