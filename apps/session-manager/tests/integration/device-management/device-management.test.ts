import { afterAll, beforeAll, describe, expect, inject } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { type BaseFastifyInstance, LogLevel } from '@scribear/base-fastify-server';

import { AppConfig } from '#src/app-config/app-config.js';
import createServer from '#src/server/create-server.js';

import { useDb } from '../../utils/use-db.js';

const TEST_API_KEY = 'TEST_API_KEY';
const TEST_DEVICE_NAME = 'test-device';
const ACTIVATION_CODE_PATTERN = /^[A-Z0-9]{8}$/;

describe('Integration Tests - Device Management API', (it) => {
  useDb(['devices']);

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
    await fastify?.close();
  });

  describe('POST /api/v1/device-management/register-device', (it) => {
    it('returns 200 with deviceId and activationCode', async () => {
      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/device-management/register-device',
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        body: { deviceName: TEST_DEVICE_NAME },
      });

      // Assert
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        deviceId: expect.any(String),
        activationCode: expect.stringMatching(ACTIVATION_CODE_PATTERN),
      });
    });

    it('returns 401 when api key is incorrect', async () => {
      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/device-management/register-device',
        headers: { authorization: 'Bearer WRONGKEY' },
        body: { deviceName: TEST_DEVICE_NAME },
      });

      // Assert
      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /api/v1/device-management/activate-device', (it) => {
    it('returns 400 when activation code does not exist', async () => {
      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/device-management/activate-device',
        body: { activationCode: 'NOTFOUND' },
      });

      // Assert
      expect(response.statusCode).toBe(400);
    });

    it('returns 200 and sets device_token cookie after register and activate', async () => {
      // Arrange
      const registerResponse = await fastify.inject({
        method: 'POST',
        url: '/api/v1/device-management/register-device',
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        body: { deviceName: TEST_DEVICE_NAME },
      });
      const { deviceId, activationCode } = registerResponse.json<{
        deviceId: string;
        activationCode: string;
      }>();

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/device-management/activate-device',
        body: { activationCode },
      });

      // Assert
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ deviceId, deviceName: TEST_DEVICE_NAME });
      expect(response.cookies).toContainEqual(
        expect.objectContaining({ name: 'device_token', httpOnly: true }),
      );
    });

    it('returns 400 when activation code has already been used', async () => {
      // Arrange
      const registerResponse = await fastify.inject({
        method: 'POST',
        url: '/api/v1/device-management/register-device',
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        body: { deviceName: TEST_DEVICE_NAME },
      });
      const { activationCode } = registerResponse.json<{ activationCode: string }>();

      await fastify.inject({
        method: 'POST',
        url: '/api/v1/device-management/activate-device',
        body: { activationCode },
      });

      // Act
      const response = await fastify.inject({
        method: 'POST',
        url: '/api/v1/device-management/activate-device',
        body: { activationCode },
      });

      // Assert
      expect(response.statusCode).toBe(400);
    });
  });
});
