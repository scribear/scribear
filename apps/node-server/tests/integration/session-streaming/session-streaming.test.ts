import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const TEST_SESSION_ID = 'integration-test-session';
const TEST_JWT_SECRET = 'test-jwt-secret-must-be-at-least-32-chars!!';
const DEBUG_PROVIDER_KEY = 'debug';
const DEBUG_PROVIDER_CONFIG = { sample_rate: 48000, num_channels: 1 };

const TEST_AUDIO_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../test_audio_files/chords/mono_f64le.wav',
);

function signSessionToken(
  sessionId: string,
  scopes: SessionTokenScope[],
  expiresIn = 3600,
): string {
  return jwt.sign({ sessionId, scopes }, TEST_JWT_SECRET, { expiresIn });
}

function buildRoute(route: { url: string }, sessionId: string): string {
  return route.url.replace(':sessionId', sessionId);
}

function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for WS message'));
    }, 2_000);
    ws.once('message', (data: Buffer) => {
      clearTimeout(timeout);
      resolve(data.toString());
    });
  });
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

describe('Integration Tests - Session Streaming', () => {
  let fastify: BaseFastifyInstance;

  beforeAll(async () => {
    const mockConfig = mock<AppConfig>({
      baseConfig: { isDevelopment: false, logLevel: LogLevel.SILENT },
      jwtServiceConfig: { jwtSecret: TEST_JWT_SECRET },
      transcriptionConfig: inject('transcriptionServiceConfig'),
    });

    const server = await createServer(mockConfig);
    fastify = server.fastify;
    await fastify.ready();
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
          type: 'AUTH',
          sessionToken: token,
        }),
      );

      // Assert
      const { code } = await waitForClose(ws);
      expect(code).toBe(1008);
    });
  });

  describe('end-to-end audio streaming', (it) => {
    it('receives transcripts when audio source sends audio and session client listens', async () => {
      // Arrange
      const sessionId = 'e2e-streaming-session';
      const audioSourceToken = signSessionToken(sessionId, [
        SessionTokenScope.SEND_AUDIO,
        SessionTokenScope.RECEIVE_TRANSCRIPTIONS,
      ]);
      const sessionClientToken = signSessionToken(sessionId, [
        SessionTokenScope.RECEIVE_TRANSCRIPTIONS,
      ]);

      const audioSourceWs = await fastify.injectWS(
        buildRoute(AUDIO_SOURCE_ROUTE, sessionId),
      );
      const sessionClientWs = await fastify.injectWS(
        buildRoute(SESSION_CLIENT_ROUTE, sessionId),
      );

      const audioData = fs.readFileSync(TEST_AUDIO_PATH);

      const audioSourceStartMsg = waitForMessage(audioSourceWs);
      const sessionClientStartMsg = waitForMessage(sessionClientWs);

      // Act
      audioSourceWs.send(
        JSON.stringify({
          type: AudioSourceClientMessageType.AUTH,
          sessionToken: audioSourceToken,
        }),
      );
      sessionClientWs.send(
        JSON.stringify({
          type: SessionClientClientMessageType.AUTH,
          sessionToken: sessionClientToken,
        }),
      );
      audioSourceWs.send(
        JSON.stringify({
          type: AudioSourceClientMessageType.CONFIG,
          providerKey: DEBUG_PROVIDER_KEY,
          config: DEBUG_PROVIDER_CONFIG,
        }),
      );
      audioSourceWs.send(audioData);

      const audioSourceStart = JSON.parse(await audioSourceStartMsg);
      const sessionClientStart = JSON.parse(await sessionClientStartMsg);
      const audioSourceTranscriptMsg = await waitForMessage(audioSourceWs);
      const sessionClientTranscriptMsg = await waitForMessage(sessionClientWs);

      // Assert
      expect(audioSourceStart.type).toBe(
        AudioSourceServerMessageType.FINAL_TRANSCRIPT,
      );
      expect(audioSourceStart.text).toEqual(
        expect.arrayContaining([expect.stringContaining('48000')]),
      );

      expect(sessionClientStart.type).toBe(
        SessionClientServerMessageType.FINAL_TRANSCRIPT,
      );
      expect(sessionClientStart.text).toEqual(
        expect.arrayContaining([expect.stringContaining('48000')]),
      );

      const audioSourceTranscript = JSON.parse(audioSourceTranscriptMsg);
      const sessionClientTranscript = JSON.parse(sessionClientTranscriptMsg);

      expect(audioSourceTranscript.type).toBe(
        AudioSourceServerMessageType.IP_TRANSCRIPT,
      );
      expect(audioSourceTranscript.text).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/Processed \d+\.\d+ seconds of audio/),
        ]),
      );

      expect(sessionClientTranscript.type).toBe(
        SessionClientServerMessageType.IP_TRANSCRIPT,
      );
      expect(sessionClientTranscript.text).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/Processed \d+\.\d+ seconds of audio/),
        ]),
      );

      // Cleanup
      audioSourceWs.close();
      sessionClientWs.close();
    });
  });
});
