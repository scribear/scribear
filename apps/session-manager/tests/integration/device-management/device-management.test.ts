import { afterAll, beforeAll, describe, expect, inject } from 'vitest';
import { mock } from 'vitest-mock-extended';

import {
  type BaseFastifyInstance,
  LogLevel,
} from '@scribear/base-fastify-server';
import {
  ACTIVATE_DEVICE_ROUTE,
  REGISTER_DEVICE_ROUTE,
} from '@scribear/session-manager-schema';

import { AppConfig } from '#src/app-config/app-config.js';
import createServer from '#src/server/create-server.js';
import { useDb } from '#tests/utils/use-db.js';

const TEST_API_KEY = 'TEST_API_KEY';
const TEST_DEVICE_NAME = 'test-device';
const ACTIVATION_CODE_PATTERN = /^[A-Z0-9]{8}$/;

describe('Integration Tests - Device Management API', () => {
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
    await fastify.close();
  });

  describe(`${REGISTER_DEVICE_ROUTE.method} ${REGISTER_DEVICE_ROUTE.url}`, (it) => {
    it('returns 200 with deviceId and activationCode', async () => {
      // Act
      const response = await fastify.inject({
        ...REGISTER_DEVICE_ROUTE,
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
        ...REGISTER_DEVICE_ROUTE,
        headers: { authorization: 'Bearer WRONGKEY' },
        body: { deviceName: TEST_DEVICE_NAME },
      });

      // Assert
      expect(response.statusCode).toBe(401);
    });
  });

  describe(`${ACTIVATE_DEVICE_ROUTE.method} ${ACTIVATE_DEVICE_ROUTE.url}`, (it) => {
    it('returns 400 when activation code does not exist', async () => {
      // Act
      const response = await fastify.inject({
        ...ACTIVATE_DEVICE_ROUTE,
        body: { activationCode: 'NOTFOUND' },
      });

      // Assert
      expect(response.statusCode).toBe(400);
    });

    it('returns 200 and sets device_token cookie after register and activate', async () => {
      // Arrange
      const registerResponse = await fastify.inject({
        ...REGISTER_DEVICE_ROUTE,
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        body: { deviceName: TEST_DEVICE_NAME },
      });
      const { deviceId, activationCode } = registerResponse.json<{
        deviceId: string;
        activationCode: string;
      }>();

      // Act
      const response = await fastify.inject({
        ...ACTIVATE_DEVICE_ROUTE,
        body: { activationCode },
      });

      // Assert
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        deviceId,
        deviceName: TEST_DEVICE_NAME,
      });
      expect(response.cookies).toContainEqual(
        expect.objectContaining({ name: 'device_token', httpOnly: true }),
      );
    });

    it('returns 400 when activation code has already been used', async () => {
      // Arrange
      const registerResponse = await fastify.inject({
        ...REGISTER_DEVICE_ROUTE,
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        body: { deviceName: TEST_DEVICE_NAME },
      });
      const { activationCode } = registerResponse.json<{
        activationCode: string;
      }>();

      await fastify.inject({
        ...ACTIVATE_DEVICE_ROUTE,
        body: { activationCode },
      });

      // Act
      const response = await fastify.inject({
        ...ACTIVATE_DEVICE_ROUTE,
        body: { activationCode },
      });

      // Assert
      expect(response.statusCode).toBe(400);
    });
  });
});
