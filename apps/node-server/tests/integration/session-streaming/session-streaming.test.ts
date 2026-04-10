import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, inject } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type WebSocket from 'ws';

import {
  type BaseFastifyInstance,
  LogLevel,
} from '@scribear/base-fastify-server';
import {
  AUDIO_SOURCE_ROUTE,
  AudioSourceClientMessageType,
  AudioSourceServerMessageType,
  SESSION_CLIENT_ROUTE,
  SessionClientClientMessageType,
  SessionClientServerMessageType,
  SessionTokenScope,
} from '@scribear/node-server-schema';

import type AppConfig from '#src/app-config/app-config.js';
import createServer from '#src/server/create-server.js';
import type { StreamingEventBusService } from '#src/server/features/session-streaming/streaming-event-bus.service.js';

const TEST_SESSION_ID = 'integration-test-session';
const TEST_JWT_SECRET = 'test-jwt-secret-must-be-at-least-32-chars!!';

function signSessionToken(
  sessionId: string,
  scopes: SessionTokenScope[],
  expiresIn = 3600,
): string {
  return jwt.sign(
    { sessionId, clientId: 'test-client', scopes },
    TEST_JWT_SECRET,
    { expiresIn },
  );
}

function buildRoute(route: { url: string }, sessionId: string): string {
  return route.url.replace(':sessionId', sessionId);
}

function waitForClose(ws: WebSocket): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for WS close'));
    }, 2_000);
    ws.once('close', (code) => {
      clearTimeout(timeout);
      resolve({ code });
    });
  });
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for WS message'));
    }, 2_000);
    ws.once('message', (data) => {
      clearTimeout(timeout);
      resolve(JSON.parse(Buffer.from(data as Buffer).toString()));
    });
  });
}

function authenticate(
  ws: WebSocket,
  sessionId: string,
  scopes: SessionTokenScope[],
  messageType: string,
): void {
  const token = signSessionToken(sessionId, scopes);
  ws.send(JSON.stringify({ type: messageType, sessionToken: token }));
}

describe('Integration Tests - Session Streaming', () => {
  let fastify: BaseFastifyInstance;
  let eventBus: StreamingEventBusService;

  beforeAll(async () => {
    const mockConfig = mock<AppConfig>({
      baseConfig: { isDevelopment: false, logLevel: LogLevel.SILENT },
      jwtServiceConfig: { jwtSecret: TEST_JWT_SECRET },
      transcriptionServiceManagerConfig: inject(
        'transcriptionServiceManagerConfig',
      ),
    });

    const server = await createServer(mockConfig);
    fastify = server.fastify;
    await fastify.ready();
    eventBus = fastify.diContainer.cradle.streamingEventBusService;
  });

  afterAll(async () => {
    await fastify.close();
  });

  describe('audio-source authentication', (it) => {
    it('closes connection with 1008 when no auth is sent within timeout', async () => {
      // Arrange
      const ws = await fastify.injectWS(
        buildRoute(AUDIO_SOURCE_ROUTE, TEST_SESSION_ID),
      );

      // Act / Assert
      const { code } = await waitForClose(ws);
      expect(code).toBe(1008);
    });

    it('closes connection with 1008 for invalid token', async () => {
      // Arrange
      const ws = await fastify.injectWS(
        buildRoute(AUDIO_SOURCE_ROUTE, TEST_SESSION_ID),
      );

      // Act
      ws.send(
        JSON.stringify({
          type: AudioSourceClientMessageType.AUTH,
          sessionToken: 'invalid-token',
        }),
      );

      // Assert
      const { code } = await waitForClose(ws);
      expect(code).toBe(1008);
    });

    it('closes connection with 1008 when session ID does not match token', async () => {
      // Arrange
      const token = signSessionToken('different-session', [
        SessionTokenScope.SEND_AUDIO,
      ]);
      const ws = await fastify.injectWS(
        buildRoute(AUDIO_SOURCE_ROUTE, TEST_SESSION_ID),
      );

      // Act
      ws.send(
        JSON.stringify({
          type: AudioSourceClientMessageType.AUTH,
          sessionToken: token,
        }),
      );

      // Assert
      const { code } = await waitForClose(ws);
      expect(code).toBe(1008);
    });

    it('closes connection with 1008 when SEND_AUDIO scope is missing', async () => {
      // Arrange
      const token = signSessionToken(TEST_SESSION_ID, [
        SessionTokenScope.RECEIVE_TRANSCRIPTIONS,
      ]);
      const ws = await fastify.injectWS(
        buildRoute(AUDIO_SOURCE_ROUTE, TEST_SESSION_ID),
      );

      // Act
      ws.send(
        JSON.stringify({
          type: AudioSourceClientMessageType.AUTH,
          sessionToken: token,
        }),
      );

      // Assert
      const { code } = await waitForClose(ws);
      expect(code).toBe(1008);
    });
  });

  describe('session-client authentication', (it) => {
    it('closes connection with 1008 when RECEIVE_TRANSCRIPTIONS scope is missing', async () => {
      // Arrange
      const token = signSessionToken(TEST_SESSION_ID, [
        SessionTokenScope.SEND_AUDIO,
      ]);
      const ws = await fastify.injectWS(
        buildRoute(SESSION_CLIENT_ROUTE, TEST_SESSION_ID),
      );

      // Act
      ws.send(
        JSON.stringify({
          type: SessionClientClientMessageType.AUTH,
          sessionToken: token,
        }),
      );

      // Assert
      const { code } = await waitForClose(ws);
      expect(code).toBe(1008);
    });
  });

  describe('session-client event forwarding', (it) => {
    it('forwards transcript events with SessionClient message type', async () => {
      // Arrange
      const sessionId = 'event-fwd-transcript';
      const ws = await fastify.injectWS(
        buildRoute(SESSION_CLIENT_ROUTE, sessionId),
      );
      authenticate(
        ws,
        sessionId,
        [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        SessionClientClientMessageType.AUTH,
      );
      const msgPromise = waitForMessage(ws);

      // Act
      // Small delay to let auth processing complete
      await new Promise((r) => setTimeout(r, 50));
      eventBus.emitTranscript(sessionId, {
        final: { text: ['done'], starts: null, ends: null },
        inProgress: { text: ['hello'], starts: [0], ends: [100] },
      });

      // Assert
      const msg = await msgPromise;
      expect(msg).toEqual({
        type: SessionClientServerMessageType.TRANSCRIPT,
        final: { text: ['done'], starts: null, ends: null },
        in_progress: { text: ['hello'], starts: [0], ends: [100] },
      });
      ws.close();
    });

    it('forwards session status events with SessionClient message type', async () => {
      // Arrange
      const sessionId = 'event-fwd-session-status';
      const ws = await fastify.injectWS(
        buildRoute(SESSION_CLIENT_ROUTE, sessionId),
      );
      authenticate(
        ws,
        sessionId,
        [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        SessionClientClientMessageType.AUTH,
      );
      const msgPromise = waitForMessage(ws);

      // Act
      await new Promise((r) => setTimeout(r, 50));
      eventBus.emitSessionStatus(sessionId, {
        transcriptionServiceConnected: true,
        sourceDeviceConnected: false,
      });

      // Assert
      const msg = await msgPromise;
      expect(msg).toEqual({
        type: SessionClientServerMessageType.SESSION_STATUS,
        transcriptionServiceConnected: true,
        sourceDeviceConnected: false,
      });
      ws.close();
    });

    it('closes connection with 1000 on session end event', async () => {
      // Arrange
      const sessionId = 'event-fwd-session-end';
      const ws = await fastify.injectWS(
        buildRoute(SESSION_CLIENT_ROUTE, sessionId),
      );
      authenticate(
        ws,
        sessionId,
        [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        SessionClientClientMessageType.AUTH,
      );
      await new Promise((r) => setTimeout(r, 50));

      // Act
      eventBus.emitSessionEnd(sessionId);

      // Assert
      const { code } = await waitForClose(ws);
      expect(code).toBe(1000);
    });
  });

  describe('audio-source event forwarding', (it) => {
    it('forwards session status events with AudioSource message type', async () => {
      // Arrange
      const sessionId = 'audio-event-fwd-status';
      const ws = await fastify.injectWS(
        buildRoute(AUDIO_SOURCE_ROUTE, sessionId),
      );
      authenticate(
        ws,
        sessionId,
        [SessionTokenScope.SEND_AUDIO],
        AudioSourceClientMessageType.AUTH,
      );

      // Wait for auth + any initial status from registerSession to settle
      await new Promise((r) => setTimeout(r, 200));
      // Drain any queued messages
      ws.on('message', () => {
        /* */
      });
      await new Promise((r) => setTimeout(r, 50));
      ws.removeAllListeners('message');

      // Act
      const msgPromise = waitForMessage(ws);
      eventBus.emitSessionStatus(sessionId, {
        transcriptionServiceConnected: false,
        sourceDeviceConnected: true,
      });

      // Assert
      const msg = await msgPromise;
      expect(msg).toEqual({
        type: AudioSourceServerMessageType.SESSION_STATUS,
        transcriptionServiceConnected: false,
        sourceDeviceConnected: true,
      });
      ws.close();
    });

    it('closes connection with 1000 on session end event', async () => {
      // Arrange
      const sessionId = 'audio-event-fwd-end';
      const ws = await fastify.injectWS(
        buildRoute(AUDIO_SOURCE_ROUTE, sessionId),
      );
      authenticate(
        ws,
        sessionId,
        [SessionTokenScope.SEND_AUDIO],
        AudioSourceClientMessageType.AUTH,
      );
      await new Promise((r) => setTimeout(r, 50));

      // Act
      eventBus.emitSessionEnd(sessionId);

      // Assert
      const { code } = await waitForClose(ws);
      expect(code).toBe(1000);
    });
  });

  describe('re-auth', (it) => {
    it('accepts a new AUTH message without dropping the connection', async () => {
      // Arrange
      const sessionId = 'reauth-test';
      const ws = await fastify.injectWS(
        buildRoute(SESSION_CLIENT_ROUTE, sessionId),
      );
      authenticate(
        ws,
        sessionId,
        [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        SessionClientClientMessageType.AUTH,
      );
      await new Promise((r) => setTimeout(r, 50));

      // Act - send a second AUTH
      authenticate(
        ws,
        sessionId,
        [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        SessionClientClientMessageType.AUTH,
      );
      await new Promise((r) => setTimeout(r, 50));

      // Assert - connection still alive, can receive events
      const msgPromise = waitForMessage(ws);
      eventBus.emitTranscript(sessionId, {
        final: null,
        inProgress: { text: ['after-reauth'], starts: null, ends: null },
      });
      const msg = await msgPromise;
      expect(msg).toEqual({
        type: SessionClientServerMessageType.TRANSCRIPT,
        final: null,
        in_progress: { text: ['after-reauth'], starts: null, ends: null },
      });
      ws.close();
    });
  });
});
