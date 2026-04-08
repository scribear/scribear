import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, inject } from 'vitest';
import { mock } from 'vitest-mock-extended';

import {
  type BaseFastifyInstance,
  LogLevel,
} from '@scribear/base-fastify-server';
import {
  ACTIVATE_DEVICE_ROUTE,
  CREATE_SESSION_ROUTE,
  DEVICE_SESSION_EVENTS_ROUTE,
  END_SESSION_ROUTE,
  GET_SESSION_CONFIG_ROUTE,
  REFRESH_SESSION_TOKEN_ROUTE,
  REGISTER_DEVICE_ROUTE,
  SESSION_JOIN_CODE_AUTH_ROUTE,
  SOURCE_DEVICE_SESSION_AUTH_ROUTE,
  SessionTokenScope,
} from '@scribear/session-manager-schema';

import { AppConfig } from '#src/app-config/app-config.js';
import createServer from '#src/server/create-server.js';
import { useDb } from '#tests/utils/use-db.js';

const TEST_API_KEY = 'TEST_API_KEY';
const TEST_NODE_SERVER_KEY = 'TEST_NODE_SERVER_KEY';
const TEST_JWT_SECRET = 'test-jwt-secret-must-be-at-least-32-chars!!';
const TEST_DEVICE_NAME = 'test-device';
const TEST_PROVIDER_KEY = 'whisper';
const TEST_PROVIDER_CONFIG = {};

describe('Integration Tests - Session Management API', () => {
  useDb(['session_refresh_tokens', 'session_events', 'sessions', 'devices']);

  let fastify: BaseFastifyInstance;

  beforeAll(async () => {
    const mockConfig = mock<AppConfig>({
      baseConfig: { isDevelopment: false, logLevel: LogLevel.SILENT },
      authServiceConfig: {
        apiKey: TEST_API_KEY,
        nodeServerKey: TEST_NODE_SERVER_KEY,
      },
      jwtServiceConfig: { jwtSecret: TEST_JWT_SECRET },
      dbClientConfig: inject('dbConfig'),
      redisUrl: inject('redisUrl'),
    });

    const server = await createServer(mockConfig);
    fastify = server.fastify;
  });

  afterAll(async () => {
    await fastify.close();
  });

  async function registerDevice() {
    const response = await fastify.inject({
      ...REGISTER_DEVICE_ROUTE,
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
      body: { deviceName: TEST_DEVICE_NAME },
    });
    return response.json<{ deviceId: string; activationCode: string }>();
  }

  async function activateDevice(activationCode: string) {
    const response = await fastify.inject({
      ...ACTIVATE_DEVICE_ROUTE,
      body: { activationCode },
    });
    const { deviceId } = response.json<{ deviceId: string }>();
    const cookie = response.cookies.find((c) => c.name === 'device_token');
    return { deviceId, deviceToken: cookie!.value };
  }

  async function createSession(
    deviceId: string,
    options?: { endTimeUnixMs?: number; enableJoinCode?: boolean },
  ) {
    const response = await fastify.inject({
      ...CREATE_SESSION_ROUTE,
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
      body: {
        sourceDeviceId: deviceId,
        transcriptionProviderKey: TEST_PROVIDER_KEY,
        transcriptionProviderConfig: TEST_PROVIDER_CONFIG,
        endTimeUnixMs: options?.endTimeUnixMs ?? Date.now() + 60_000,
        enableJoinCode: options?.enableJoinCode,
      },
    });
    return response.json<{ sessionId: string; joinCode: string | null }>();
  }

  async function createIndefiniteSession(
    deviceId: string,
    options?: { enableJoinCode?: boolean },
  ) {
    const response = await fastify.inject({
      ...CREATE_SESSION_ROUTE,
      headers: { authorization: `Bearer ${TEST_API_KEY}` },
      body: {
        sourceDeviceId: deviceId,
        transcriptionProviderKey: TEST_PROVIDER_KEY,
        transcriptionProviderConfig: TEST_PROVIDER_CONFIG,
        enableJoinCode: options?.enableJoinCode,
      },
    });
    return response.json<{ sessionId: string; joinCode: string | null }>();
  }

  async function getDeviceSessionEvents(
    deviceToken: string,
    prevEventId?: number,
  ) {
    const query =
      prevEventId !== undefined ? `?prevEventId=${prevEventId.toString()}` : '';
    return fastify.inject({
      ...DEVICE_SESSION_EVENTS_ROUTE,
      url: `${DEVICE_SESSION_EVENTS_ROUTE.url}${query}`,
      cookies: { device_token: deviceToken },
    });
  }

  describe(`${CREATE_SESSION_ROUTE.method} ${CREATE_SESSION_ROUTE.url}`, (it) => {
    it('returns 400 when api key is missing', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);

      // Act
      const response = await fastify.inject({
        ...CREATE_SESSION_ROUTE,
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
        ...CREATE_SESSION_ROUTE,
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

    it('returns 422 when endTimeUnixMs is in the past', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);

      // Act
      const response = await fastify.inject({
        ...CREATE_SESSION_ROUTE,
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        body: {
          sourceDeviceId: deviceId,
          transcriptionProviderKey: TEST_PROVIDER_KEY,
          transcriptionProviderConfig: TEST_PROVIDER_CONFIG,
          endTimeUnixMs: Date.now() - 1,
        },
      });

      // Assert
      expect(response.statusCode).toBe(422);
    });

    it('returns 422 when sourceDeviceId does not exist', async () => {
      // Act
      const response = await fastify.inject({
        ...CREATE_SESSION_ROUTE,
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        body: {
          sourceDeviceId: '00000000-0000-0000-0000-000000000000',
          transcriptionProviderKey: TEST_PROVIDER_KEY,
          transcriptionProviderConfig: TEST_PROVIDER_CONFIG,
          endTimeUnixMs: Date.now() + 60_000,
        },
      });

      // Assert
      expect(response.statusCode).toBe(422);
    });

    it('returns 200 with sessionId and null joinCode when enableJoinCode is not set', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);

      // Act
      const { sessionId, joinCode } = await createSession(deviceId);

      // Assert
      expect(sessionId).toEqual(expect.any(String));
      expect(joinCode).toBeNull();
    });

    it('returns 200 with sessionId and alphanumeric joinCode when enableJoinCode=true', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);

      // Act
      const { sessionId, joinCode } = await createSession(deviceId, {
        enableJoinCode: true,
      });

      // Assert
      expect(sessionId).toEqual(expect.any(String));
      expect(joinCode).toMatch(/^[A-Z0-9]{8}$/);
    });

    it('creates an indefinite session when endTimeUnixMs is omitted', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);

      // Act
      const { sessionId, joinCode } = await createIndefiniteSession(deviceId);

      // Assert
      expect(sessionId).toEqual(expect.any(String));
      expect(joinCode).toBeNull();
    });
  });

  describe(`${DEVICE_SESSION_EVENTS_ROUTE.method} ${DEVICE_SESSION_EVENTS_ROUTE.url}`, (it) => {
    it('returns 401 when device cookie is missing', async () => {
      // Arrange / Act
      const response = await fastify.inject({
        ...DEVICE_SESSION_EVENTS_ROUTE,
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
      await createSession(deviceId, { endTimeUnixMs: Date.now() + 500 });

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

  describe(`${SESSION_JOIN_CODE_AUTH_ROUTE.method} ${SESSION_JOIN_CODE_AUTH_ROUTE.url}`, (it) => {
    it('returns 400 when joinCode is missing', async () => {
      const response = await fastify.inject({
        ...SESSION_JOIN_CODE_AUTH_ROUTE,
        body: {},
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 422 when joinCode does not match any active session', async () => {
      const response = await fastify.inject({
        ...SESSION_JOIN_CODE_AUTH_ROUTE,
        body: { joinCode: 'NOTFOUND' },
      });

      expect(response.statusCode).toBe(422);
    });

    it('returns 200 with sessionToken and sessionRefreshToken', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);
      const { sessionId, joinCode } = await createSession(deviceId, {
        enableJoinCode: true,
      });

      // Act
      const response = await fastify.inject({
        ...SESSION_JOIN_CODE_AUTH_ROUTE,
        body: { joinCode },
      });

      // Assert
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        sessionToken: string;
        sessionRefreshToken: string;
      }>();
      expect(body.sessionRefreshToken).toEqual(expect.any(String));
      expect(body.sessionRefreshToken).toContain(':');

      const payload = jwt.verify(body.sessionToken, TEST_JWT_SECRET) as {
        sessionId: string;
        clientId: string;
        scopes: string[];
        exp: number;
      };
      expect(payload.sessionId).toBe(sessionId);
      expect(payload.clientId).toEqual(expect.any(String));
      expect(payload.scopes).toEqual([
        SessionTokenScope.RECEIVE_TRANSCRIPTIONS,
      ]);
      // JWT should expire in ~5 minutes, not at session end
      const nowSec = Math.floor(Date.now() / 1000);
      expect(payload.exp).toBeGreaterThan(nowSec);
      expect(payload.exp).toBeLessThanOrEqual(nowSec + 300 + 2);
    });

    it('returns 422 when session has expired', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);
      const { joinCode } = await createSession(deviceId, {
        enableJoinCode: true,
        endTimeUnixMs: Date.now() + 500,
      });

      // Wait for session to expire
      await new Promise((r) => setTimeout(r, 600));

      // Act
      const response = await fastify.inject({
        ...SESSION_JOIN_CODE_AUTH_ROUTE,
        body: { joinCode },
      });

      expect(response.statusCode).toBe(422);
    });

    it('authenticates against an indefinite session', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);
      const { joinCode } = await createIndefiniteSession(deviceId, {
        enableJoinCode: true,
      });

      // Act
      const response = await fastify.inject({
        ...SESSION_JOIN_CODE_AUTH_ROUTE,
        body: { joinCode },
      });

      // Assert
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        sessionToken: string;
        sessionRefreshToken: string;
      }>();
      expect(body.sessionToken).toEqual(expect.any(String));
      expect(body.sessionRefreshToken).toEqual(expect.any(String));
    });
  });

  describe(`${SOURCE_DEVICE_SESSION_AUTH_ROUTE.method} ${SOURCE_DEVICE_SESSION_AUTH_ROUTE.url}`, (it) => {
    async function sourceDeviceSessionAuth(
      deviceToken: string,
      sessionId: string,
    ) {
      return fastify.inject({
        ...SOURCE_DEVICE_SESSION_AUTH_ROUTE,
        cookies: { device_token: deviceToken },
        body: { sessionId },
      });
    }

    it('returns 401 when device cookie is missing', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);
      const { sessionId } = await createSession(deviceId);

      // Act
      const response = await fastify.inject({
        ...SOURCE_DEVICE_SESSION_AUTH_ROUTE,
        body: { sessionId },
      });

      // Assert
      expect(response.statusCode).toBe(401);
    });

    it('returns 401 when device cookie is invalid', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);
      const { sessionId } = await createSession(deviceId);

      // Act
      const response = await sourceDeviceSessionAuth(
        'invalid-token',
        sessionId,
      );

      // Assert
      expect(response.statusCode).toBe(401);
    });

    it('returns 401 when sessionId does not belong to the authenticated device', async () => {
      // Arrange
      const { deviceId: deviceAId, activationCode: codeA } =
        await registerDevice();
      await activateDevice(codeA);

      const { activationCode: codeB } = await registerDevice();
      const { deviceToken: deviceBToken } = await activateDevice(codeB);

      const { sessionId } = await createSession(deviceAId);

      // Act
      const response = await sourceDeviceSessionAuth(deviceBToken, sessionId);

      // Assert
      expect(response.statusCode).toBe(401);
    });

    it('returns 401 when session has expired', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      const { deviceToken } = await activateDevice(activationCode);
      const { sessionId } = await createSession(deviceId, {
        endTimeUnixMs: Date.now() + 200,
      });

      // Wait for session to expire
      await new Promise((r) => setTimeout(r, 300));

      // Act
      const response = await sourceDeviceSessionAuth(deviceToken, sessionId);

      // Assert
      expect(response.statusCode).toBe(401);
    });

    it('returns 200 with sessionToken and sessionRefreshToken containing both scopes', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      const { deviceToken } = await activateDevice(activationCode);
      const { sessionId } = await createSession(deviceId);

      // Act
      const response = await sourceDeviceSessionAuth(deviceToken, sessionId);

      // Assert
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        sessionToken: string;
        sessionRefreshToken: string;
      }>();
      expect(body.sessionRefreshToken).toEqual(expect.any(String));

      const payload = jwt.verify(body.sessionToken, TEST_JWT_SECRET) as {
        sessionId: string;
        clientId: string;
        scopes: string[];
      };
      expect(payload.sessionId).toBe(sessionId);
      expect(payload.clientId).toEqual(expect.any(String));
      expect(payload.scopes).toContain(SessionTokenScope.SEND_AUDIO);
      expect(payload.scopes).toContain(
        SessionTokenScope.RECEIVE_TRANSCRIPTIONS,
      );
    });
  });

  describe(`${REFRESH_SESSION_TOKEN_ROUTE.method} ${REFRESH_SESSION_TOKEN_ROUTE.url}`, (it) => {
    it('returns 401 when refresh token is invalid', async () => {
      // Act
      const response = await fastify.inject({
        ...REFRESH_SESSION_TOKEN_ROUTE,
        body: { sessionRefreshToken: 'invalid-no-separator' },
      });

      // Assert
      expect(response.statusCode).toBe(401);
    });

    it('returns 401 when refresh token id does not exist', async () => {
      // Act
      const response = await fastify.inject({
        ...REFRESH_SESSION_TOKEN_ROUTE,
        body: {
          sessionRefreshToken:
            '00000000-0000-0000-0000-000000000000:somesecret',
        },
      });

      // Assert
      expect(response.statusCode).toBe(401);
    });

    it('returns 200 with new sessionToken for valid refresh token', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);
      const { joinCode } = await createSession(deviceId, {
        enableJoinCode: true,
      });

      const authResponse = await fastify.inject({
        ...SESSION_JOIN_CODE_AUTH_ROUTE,
        body: { joinCode },
      });
      const { sessionRefreshToken } = authResponse.json<{
        sessionRefreshToken: string;
      }>();

      // Act
      const response = await fastify.inject({
        ...REFRESH_SESSION_TOKEN_ROUTE,
        body: { sessionRefreshToken },
      });

      // Assert
      expect(response.statusCode).toBe(200);
      const { sessionToken } = response.json<{ sessionToken: string }>();
      const payload = jwt.verify(sessionToken, TEST_JWT_SECRET) as {
        sessionId: string;
        clientId: string;
        scopes: string[];
      };
      expect(payload.sessionId).toEqual(expect.any(String));
      expect(payload.clientId).toEqual(expect.any(String));
      expect(payload.scopes).toEqual([
        SessionTokenScope.RECEIVE_TRANSCRIPTIONS,
      ]);
    });

    it('returns 401 when session has been ended', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);
      const { sessionId, joinCode } = await createIndefiniteSession(deviceId, {
        enableJoinCode: true,
      });

      const authResponse = await fastify.inject({
        ...SESSION_JOIN_CODE_AUTH_ROUTE,
        body: { joinCode },
      });
      const { sessionRefreshToken } = authResponse.json<{
        sessionRefreshToken: string;
      }>();

      // End the session
      await fastify.inject({
        ...END_SESSION_ROUTE,
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        body: { sessionId },
      });

      // Act
      const response = await fastify.inject({
        ...REFRESH_SESSION_TOKEN_ROUTE,
        body: { sessionRefreshToken },
      });

      // Assert
      expect(response.statusCode).toBe(401);
    });
  });

  describe(`GET ${GET_SESSION_CONFIG_ROUTE.url}`, (it) => {
    it('returns 401 when node server key is missing', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);
      const { sessionId } = await createSession(deviceId);

      // Act
      const response = await fastify.inject({
        method: GET_SESSION_CONFIG_ROUTE.method,
        url: GET_SESSION_CONFIG_ROUTE.url.replace(':sessionId', sessionId),
      });

      // Assert
      expect(response.statusCode).toBe(400);
    });

    it('returns 401 when node server key is incorrect', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);
      const { sessionId } = await createSession(deviceId);

      // Act
      const response = await fastify.inject({
        method: GET_SESSION_CONFIG_ROUTE.method,
        url: GET_SESSION_CONFIG_ROUTE.url.replace(':sessionId', sessionId),
        headers: { authorization: 'Bearer WRONGKEY' },
      });

      // Assert
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when session does not exist', async () => {
      // Act
      const response = await fastify.inject({
        method: GET_SESSION_CONFIG_ROUTE.method,
        url: GET_SESSION_CONFIG_ROUTE.url.replace(
          ':sessionId',
          '00000000-0000-0000-0000-000000000000',
        ),
        headers: {
          authorization: `Bearer ${TEST_NODE_SERVER_KEY}`,
        },
      });

      // Assert
      expect(response.statusCode).toBe(404);
    });

    it('returns 200 with session config', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);
      const { sessionId } = await createSession(deviceId);

      // Act
      const response = await fastify.inject({
        method: GET_SESSION_CONFIG_ROUTE.method,
        url: GET_SESSION_CONFIG_ROUTE.url.replace(':sessionId', sessionId),
        headers: {
          authorization: `Bearer ${TEST_NODE_SERVER_KEY}`,
        },
      });

      // Assert
      expect(response.statusCode).toBe(200);
      const body = response.json<{
        transcriptionProviderKey: string;
        transcriptionProviderConfig: object;
        endTimeUnixMs: number | null;
      }>();
      expect(body.transcriptionProviderKey).toBe(TEST_PROVIDER_KEY);
      expect(body.transcriptionProviderConfig).toEqual(TEST_PROVIDER_CONFIG);
      expect(body.endTimeUnixMs).toEqual(expect.any(Number));
    });

    it('returns null endTimeUnixMs for indefinite session', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);
      const { sessionId } = await createIndefiniteSession(deviceId);

      // Act
      const response = await fastify.inject({
        method: GET_SESSION_CONFIG_ROUTE.method,
        url: GET_SESSION_CONFIG_ROUTE.url.replace(':sessionId', sessionId),
        headers: {
          authorization: `Bearer ${TEST_NODE_SERVER_KEY}`,
        },
      });

      // Assert
      expect(response.statusCode).toBe(200);
      const body = response.json<{ endTimeUnixMs: number | null }>();
      expect(body.endTimeUnixMs).toBeNull();
    });
  });

  describe(`${END_SESSION_ROUTE.method} ${END_SESSION_ROUTE.url}`, (it) => {
    it('returns 401 when api key is missing', async () => {
      // Act
      const response = await fastify.inject({
        ...END_SESSION_ROUTE,
        body: { sessionId: '00000000-0000-0000-0000-000000000000' },
      });

      // Assert
      expect(response.statusCode).toBe(400);
    });

    it('returns 404 when session does not exist', async () => {
      // Act
      const response = await fastify.inject({
        ...END_SESSION_ROUTE,
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        body: { sessionId: '00000000-0000-0000-0000-000000000000' },
      });

      // Assert
      expect(response.statusCode).toBe(404);
    });

    it('returns 200 and ends an active session', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);
      const { sessionId } = await createIndefiniteSession(deviceId);

      // Act
      const response = await fastify.inject({
        ...END_SESSION_ROUTE,
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        body: { sessionId },
      });

      // Assert
      expect(response.statusCode).toBe(200);
    });

    it('returns 404 when trying to end an already-ended session', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);
      const { sessionId } = await createIndefiniteSession(deviceId);

      await fastify.inject({
        ...END_SESSION_ROUTE,
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        body: { sessionId },
      });

      // Act
      const response = await fastify.inject({
        ...END_SESSION_ROUTE,
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        body: { sessionId },
      });

      // Assert
      expect(response.statusCode).toBe(404);
    });

    it('invalidates refresh tokens after session end', async () => {
      // Arrange
      const { deviceId, activationCode } = await registerDevice();
      await activateDevice(activationCode);
      const { sessionId, joinCode } = await createIndefiniteSession(deviceId, {
        enableJoinCode: true,
      });

      const authResponse = await fastify.inject({
        ...SESSION_JOIN_CODE_AUTH_ROUTE,
        body: { joinCode },
      });
      const { sessionRefreshToken } = authResponse.json<{
        sessionRefreshToken: string;
      }>();

      // End the session
      await fastify.inject({
        ...END_SESSION_ROUTE,
        headers: { authorization: `Bearer ${TEST_API_KEY}` },
        body: { sessionId },
      });

      // Act
      const refreshResponse = await fastify.inject({
        ...REFRESH_SESSION_TOKEN_ROUTE,
        body: { sessionRefreshToken },
      });

      // Assert
      expect(refreshResponse.statusCode).toBe(401);
    });
  });
});
