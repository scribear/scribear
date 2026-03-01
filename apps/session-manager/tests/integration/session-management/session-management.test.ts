import { afterAll, beforeAll, describe, expect, inject } from 'vitest';
import { mock } from 'vitest-mock-extended';

import {
  type BaseFastifyInstance,
  LogLevel,
} from '@scribear/base-fastify-server';

import { AppConfig } from '#src/app-config/app-config.js';
import createServer from '#src/server/create-server.js';
import { useDb } from '#tests/utils/use-db.js';

const TEST_API_KEY = 'TEST_API_KEY';
const TEST_DEVICE_NAME = 'test-device';
const TEST_PROVIDER_KEY = 'deepgram';
const TEST_PROVIDER_CONFIG = { apiKey: 'test-api-key' };

describe('Integration Tests - Session Management API', () => {
  useDb(['session_events', 'sessions', 'devices']);

  let fastify: BaseFastifyInstance;

  beforeAll(async () => {
    const mockConfig = mock<AppConfig>({
      baseConfig: { isDevelopment: false, logLevel: LogLevel.SILENT },
      authServiceConfig: { apiKey: TEST_API_KEY },
      dbClientConfig: inject('dbConfig'),
    });

    const server = await createServer(mockConfig);
    fastify = server.fastify;
  });

  afterAll(async () => {
    await fastify.close();
  });

  async function registerDevice() {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/device-management/register-device',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
      body: { deviceName: TEST_DEVICE_NAME },
    });
    return response.json<{ deviceId: string; activationCode: string }>();
  }

  async function activateDevice(activationCode: string) {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/device-management/activate-device',
      body: { activationCode },
    });
    const { deviceId } = response.json<{ deviceId: string }>();
    const cookie = response.cookies.find((c) => c.name === 'device_token');
    return { deviceId, deviceToken: cookie!.value };
  }

  async function createSession(deviceId: string, endTimeUnixMs?: number) {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/v1/session-management/create-session',
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
      body: {
        sourceDeviceId: deviceId,
        transcriptionProviderKey: TEST_PROVIDER_KEY,
        transcriptionProviderConfig: TEST_PROVIDER_CONFIG,
        endTimeUnixMs: endTimeUnixMs ?? Date.now() + 60_000,
      },
    });
    return response.json<{ sessionId: string }>();
  }

  async function getDeviceSessionEvents(
    deviceToken: string,
    prevEventId?: number,
  ) {
    const query =
      prevEventId !== undefined ? `?prevEventId=${prevEventId}` : '';
    return fastify.inject({
      method: 'GET',
      url: `/api/v1/session-management/device-session-events${query}`,
      cookies: { device_token: deviceToken },
    });
  }

  describe('POST /api/v1/session-management/create-session', (it) => {
    it('returns 400 when api key is missing', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/session-management/create-session',
        body: {
          sourceDeviceId: deviceId,
          transcriptionProviderKey: TEST_PROVIDER_KEY,
          transcriptionProviderConfig: TEST_PROVIDER_CONFIG,
          endTimeUnixMs: Date.now() + 60_000,
        },
      });

      // Assert
      expect(response.statusCode).toBe(400);
    });

    it('returns 401 when api key is incorrect', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/session-management/create-session',
        headers: { authorization: 'Bearer WRONGKEY' },
        body: {
          sourceDeviceId: deviceId,
          transcriptionProviderKey: TEST_PROVIDER_KEY,
          transcriptionProviderConfig: TEST_PROVIDER_CONFIG,
          endTimeUnixMs: Date.now() + 60_000,
        },
      });

      // Assert
      expect(response.statusCode).toBe(401);
    });

    it('returns 400 when endTimeUnixMs is in the past', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/session-management/create-session',
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        body: {
          sourceDeviceId: deviceId,
          transcriptionProviderKey: TEST_PROVIDER_KEY,
          transcriptionProviderConfig: TEST_PROVIDER_CONFIG,
          endTimeUnixMs: Date.now() - 1,
        },
      });

      // Assert
      expect(response.statusCode).toBe(400);
      expect(response.json().requestErrors).toContainEqual(
        expect.objectContaining({ key: 'endTimeUnixMs' }),
      );
    });

    it('returns 400 when sourceDeviceId does not exist', async () => {
      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/session-management/create-session',
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        body: {
          sourceDeviceId: '00000000-0000-0000-0000-000000000000',
          transcriptionProviderKey: TEST_PROVIDER_KEY,
          transcriptionProviderConfig: TEST_PROVIDER_CONFIG,
          endTimeUnixMs: Date.now() + 60_000,
        },
      });

      // Assert
      expect(response.statusCode).toBe(400);
      expect(response.json().requestErrors).toContainEqual(
        expect.objectContaining({ key: 'sourceDeviceId' }),
      );
    });

    it('returns 200 with sessionId after registering and activating a device', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/session-management/create-session',
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        body: {
          sourceDeviceId: deviceId,
          transcriptionProviderKey: TEST_PROVIDER_KEY,
          transcriptionProviderConfig: TEST_PROVIDER_CONFIG,
          endTimeUnixMs: Date.now() + 60_000,
        },
      });

      // Assert
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        sessionId: expect.any(String),
      });
    });
  });

  describe('GET /api/v1/session-management/device-session-events', (it) => {
    it('returns 401 when device cookie is missing', async () => {
      // Arrange / Act
      const response = await fastify.inject({
        method: 'GET',
        url: '/api/v1/session-management/device-session-events',
      });

      // Assert
      expect(response.statusCode).toBe(401);
    });

    it('returns 401 when device cookie is invalid', async () => {
      // Arrange / Act
      const response = await getDeviceSessionEvents('invalid-token');

      // Assert
      expect(response.statusCode).toBe(401);
    });

    it('returns START_SESSION event immediately when session already exists', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      const { deviceToken } = await activateDevice(activationCode);
      await createSession(deviceId);

      // Act
      const response = await getDeviceSessionEvents(deviceToken);

      // Assert
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        eventId: expect.any(Number),
        eventType: 'START_SESSION',
        sessionId: expect.any(String),
        timestampUnixMs: expect.any(Number),
      });
    });

    it('returns START_SESSION event via bus when session is created while polling', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      const { deviceToken } = await activateDevice(activationCode);

      // Start polling before session exists so it waits on the event bus
      const pollPromise = getDeviceSessionEvents(deviceToken);
      await new Promise((r) => setTimeout(r, 50));

      // Act
      await createSession(deviceId);
      const response = await pollPromise;

      // Assert
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        eventId: expect.any(Number),
        eventType: 'START_SESSION',
        sessionId: expect.any(String),
        timestampUnixMs: expect.any(Number),
      });
    });

    it('returns END_SESSION event when polling after START_SESSION with prevEventId', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      const { deviceToken } = await activateDevice(activationCode);

      // Create a session that ends very soon so END_SESSION falls within the poll window
      await createSession(deviceId, Date.now() + 500);

      // Consume the START_SESSION event first
      const startResponse = await getDeviceSessionEvents(deviceToken);
      const { eventId: startEventId } = startResponse.json<{
        eventId: number;
      }>();

      // Act
      const response = await getDeviceSessionEvents(deviceToken, startEventId);

      // Assert
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        eventId: expect.any(Number),
        eventType: 'END_SESSION',
        sessionId: expect.any(String),
        timestampUnixMs: expect.any(Number),
      });
    });
  });
});
