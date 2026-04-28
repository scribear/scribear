import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, inject, vi } from 'vitest';
import type WebSocket from 'ws';

import {
  TranscriptionStreamClientMessageType,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';
import type { SessionTokenPayload } from '@scribear/session-manager-schema';

import { seedSession } from '#tests/utils/seed-session.js';
import { useServer } from '#tests/utils/use-server.js';

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;
const DEBUG_SAMPLE_RATE = 48000;
const DEBUG_NUM_CHANNELS = 1;
const FAKE_SESSION_UID = '00000000-0000-0000-0000-000000000abc';

const TEST_AUDIO_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../test_audio_files/chords/mono_f64le.wav',
);
const TEST_AUDIO = fs.readFileSync(TEST_AUDIO_PATH);

function signToken(payload: SessionTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  const signature = crypto
    .createHmac('sha256', inject('sessionTokenSigningKey'))
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

function bufferOf(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data);
}

function decodeJson(data: Buffer | ArrayBuffer | Buffer[]): unknown {
  return JSON.parse(bufferOf(data).toString('utf8'));
}

/** Wait for the WS to close and return the close code + reason. */
function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code: number, reason: Buffer) => {
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
}

/**
 * Collect all server messages from the WS into a stable array. Returns the
 * array (mutated as messages arrive) plus an unsubscribe function.
 */
function collectMessages(ws: WebSocket): {
  messages: { type: string; [key: string]: unknown }[];
  stop: () => void;
} {
  const messages: { type: string; [key: string]: unknown }[] = [];
  const handler = (data: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const parsed = decodeJson(data) as { type: string };
      messages.push(parsed);
    } catch {
      /* ignore non-JSON frames */
    }
  };
  ws.on('message', handler);
  return {
    messages,
    stop: () => {
      ws.off('message', handler);
    },
  };
}

describe('Transcription Stream Routes', () => {
  const server = useServer();

  // Bootstrap a real on-demand session whose `transcriptionProviderId` points
  // at the live transcription service's `debug` provider. Positive tests
  // share this session and the orchestrator drives a real upstream WS for it.
  let realSessionUid: string;
  beforeAll(async () => {
    const session = await seedSession({
      sessionManagerBaseUrl: inject('sessionManagerBaseUrl'),
      adminApiKey: inject('adminApiKey'),
      transcriptionProviderId: 'debug',
      transcriptionStreamConfig: {
        sample_rate: DEBUG_SAMPLE_RATE,
        num_channels: DEBUG_NUM_CHANNELS,
      },
    });
    realSessionUid = session.uid;
  });

  function sourcePath(sessionUid: string): string {
    return `/api/node-server/v1/transcription-stream/${sessionUid}/source`;
  }
  function clientPath(sessionUid: string): string {
    return `/api/node-server/v1/transcription-stream/${sessionUid}/client`;
  }

  describe('GET /transcription-stream/:sessionUid/source (no upgrade)', (it) => {
    it('returns 426 when called without a WebSocket upgrade', async () => {
      // Arrange / Act
      const res = await server.fastify.inject({
        method: 'GET',
        url: sourcePath(FAKE_SESSION_UID),
      });

      // Assert
      expect(res.statusCode).toBe(426);
      expect(res.headers.upgrade).toBe('websocket');
      const body = res.json<{ code: string }>();
      expect(body.code).toBe('UPGRADE_REQUIRED');
    });
  });

  // Auth-rejection tests - these fail before the orchestrator is reached, so
  // the URL sessionUid does not need to exist in Session Manager.
  describe('auth rejection', (it) => {
    it('source: closes 1008 missing-scope when token lacks SEND_AUDIO', async () => {
      // Arrange
      const ws = await server.fastify.injectWS(sourcePath(FAKE_SESSION_UID));

      // Act
      ws.send(
        JSON.stringify({
          type: TranscriptionStreamClientMessageType.AUTH,
          sessionToken: signToken({
            sessionUid: FAKE_SESSION_UID,
            clientId: 'rej-1',
            scopes: ['RECEIVE_TRANSCRIPTIONS'],
            exp: FAR_FUTURE,
          }),
        }),
      );
      const closed = await nextClose(ws);

      // Assert
      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe('missing-scope');
    });

    it("source: closes 1008 session-mismatch when token's sessionUid does not match URL", async () => {
      // Arrange
      const ws = await server.fastify.injectWS(sourcePath(FAKE_SESSION_UID));

      // Act
      ws.send(
        JSON.stringify({
          type: TranscriptionStreamClientMessageType.AUTH,
          sessionToken: signToken({
            sessionUid: '00000000-0000-0000-0000-000000000999',
            clientId: 'rej-2',
            scopes: ['SEND_AUDIO'],
            exp: FAR_FUTURE,
          }),
        }),
      );
      const closed = await nextClose(ws);

      // Assert
      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe('session-mismatch');
    });

    it('source: closes 1007 when client sends invalid JSON', async () => {
      // Arrange
      const ws = await server.fastify.injectWS(sourcePath(FAKE_SESSION_UID));

      // Act
      ws.send('this is not json');
      const closed = await nextClose(ws);

      // Assert
      expect(closed.code).toBe(1007);
    });

    it('client: closes 1008 missing-scope when token lacks RECEIVE_TRANSCRIPTIONS', async () => {
      // Arrange
      const ws = await server.fastify.injectWS(clientPath(FAKE_SESSION_UID));

      // Act
      ws.send(
        JSON.stringify({
          type: TranscriptionStreamClientMessageType.AUTH,
          sessionToken: signToken({
            sessionUid: FAKE_SESSION_UID,
            clientId: 'rej-3',
            scopes: ['SEND_AUDIO'],
            exp: FAR_FUTURE,
          }),
        }),
      );
      const closed = await nextClose(ws);

      // Assert
      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe('missing-scope');
    });
  });

  describe('source role with live upstream', (it) => {
    it(
      'completes auth and emits initial session status',
      { timeout: 30_000 },
      async () => {
        // Arrange
        const ws = await server.fastify.injectWS(sourcePath(realSessionUid));
        const { messages, stop } = collectMessages(ws);

        // Act
        ws.send(
          JSON.stringify({
            type: TranscriptionStreamClientMessageType.AUTH,
            sessionToken: signToken({
              sessionUid: realSessionUid,
              clientId: 'src-auth',
              scopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
              exp: FAR_FUTURE,
            }),
          }),
        );
        await vi.waitFor(
          () => {
            expect(
              messages.find(
                (m) => m.type === TranscriptionStreamServerMessageType.AUTH_OK,
              ),
            ).toBeDefined();
          },
          { timeout: 15_000 },
        );

        // Assert - authOk arrives first, immediately followed by an initial
        // session-status snapshot reflecting current orchestrator state.
        expect(messages[0]).toEqual({
          type: TranscriptionStreamServerMessageType.AUTH_OK,
        });
        const status = messages.find(
          (m) =>
            m.type === TranscriptionStreamServerMessageType.SESSION_STATUS,
        );
        expect(status).toBeDefined();
        expect(status).toMatchObject({
          type: TranscriptionStreamServerMessageType.SESSION_STATUS,
          sourceDeviceConnected: expect.any(Boolean),
          transcriptionServiceConnected: expect.any(Boolean),
        });

        stop();
        ws.terminate();
      },
    );

    it(
      'forwards audio to the live upstream and receives debug-provider transcripts',
      { timeout: 60_000 },
      async () => {
        // Arrange
        const ws = await server.fastify.injectWS(sourcePath(realSessionUid));
        const { messages, stop } = collectMessages(ws);
        ws.send(
          JSON.stringify({
            type: TranscriptionStreamClientMessageType.AUTH,
            sessionToken: signToken({
              sessionUid: realSessionUid,
              clientId: 'src-audio',
              scopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
              exp: FAR_FUTURE,
            }),
          }),
        );
        await vi.waitFor(
          () => {
            expect(
              messages.find(
                (m) => m.type === TranscriptionStreamServerMessageType.AUTH_OK,
              ),
            ).toBeDefined();
          },
          { timeout: 15_000 },
        );

        // Wait for upstream to reach OPEN before sending audio so the debug
        // provider's start_session emits the initial config-echo transcript.
        await vi.waitFor(
          () => {
            const status = [...messages]
              .reverse()
              .find(
                (m) =>
                  m.type ===
                  TranscriptionStreamServerMessageType.SESSION_STATUS,
              );
            expect(status).toMatchObject({
              transcriptionServiceConnected: true,
            });
          },
          { timeout: 30_000 },
        );

        // Act - send a real WAV file the AudioDecoder can parse.
        ws.send(TEST_AUDIO);

        // Wait specifically for the debug provider's audio-decode result
        // ("Processed N seconds") rather than just the start_session echo, so
        // a passing test proves audio actually round-tripped through the
        // upstream worker pool.
        await vi.waitFor(
          () => {
            const allText = messages
              .filter(
                (m) =>
                  m.type === TranscriptionStreamServerMessageType.TRANSCRIPT,
              )
              .flatMap((m) => {
                const final = (m as { final?: { text?: string[] } | null })
                  .final;
                const inProgress = (
                  m as { inProgress?: { text?: string[] } | null }
                ).inProgress;
                return [...(final?.text ?? []), ...(inProgress?.text ?? [])];
              })
              .join(' ');
            expect(allText).toMatch(/Processed [\d.]+ seconds of audio/);
            expect(allText).toContain(
              `sample rate: ${String(DEBUG_SAMPLE_RATE)}`,
            );
          },
          { timeout: 30_000 },
        );

        stop();
        ws.terminate();
      },
    );

    it(
      'fans transcripts out to a paired client connection',
      { timeout: 60_000 },
      async () => {
        // Arrange - open a client connection first; it should receive any
        // transcripts the orchestrator publishes once a source starts feeding
        // audio.
        const clientWs = await server.fastify.injectWS(
          clientPath(realSessionUid),
        );
        const client = collectMessages(clientWs);
        clientWs.send(
          JSON.stringify({
            type: TranscriptionStreamClientMessageType.AUTH,
            sessionToken: signToken({
              sessionUid: realSessionUid,
              clientId: 'pair-client',
              scopes: ['RECEIVE_TRANSCRIPTIONS'],
              exp: FAR_FUTURE,
            }),
          }),
        );
        await vi.waitFor(
          () => {
            expect(
              client.messages.find(
                (m) => m.type === TranscriptionStreamServerMessageType.AUTH_OK,
              ),
            ).toBeDefined();
          },
          { timeout: 15_000 },
        );

        const sourceWs = await server.fastify.injectWS(
          sourcePath(realSessionUid),
        );
        const source = collectMessages(sourceWs);
        sourceWs.send(
          JSON.stringify({
            type: TranscriptionStreamClientMessageType.AUTH,
            sessionToken: signToken({
              sessionUid: realSessionUid,
              clientId: 'pair-source',
              scopes: ['SEND_AUDIO'],
              exp: FAR_FUTURE,
            }),
          }),
        );
        await vi.waitFor(
          () => {
            expect(
              source.messages.find(
                (m) => m.type === TranscriptionStreamServerMessageType.AUTH_OK,
              ),
            ).toBeDefined();
          },
          { timeout: 15_000 },
        );

        await vi.waitFor(
          () => {
            const status = [...source.messages]
              .reverse()
              .find(
                (m) =>
                  m.type ===
                  TranscriptionStreamServerMessageType.SESSION_STATUS,
              );
            expect(status).toMatchObject({
              transcriptionServiceConnected: true,
            });
          },
          { timeout: 30_000 },
        );

        // Act
        sourceWs.send(TEST_AUDIO);

        // Assert - the client connection receives the same transcripts.
        await vi.waitFor(
          () => {
            const transcripts = client.messages.filter(
              (m) =>
                m.type === TranscriptionStreamServerMessageType.TRANSCRIPT,
            );
            expect(transcripts.length).toBeGreaterThan(0);
          },
          { timeout: 30_000 },
        );

        client.stop();
        source.stop();
        clientWs.terminate();
        sourceWs.terminate();
      },
    );

    it(
      'updates session status to disconnected when the last source terminates',
      { timeout: 30_000 },
      async () => {
        // Arrange - watch via a client connection so we can observe status
        // transitions after the source disconnects.
        const clientWs = await server.fastify.injectWS(
          clientPath(realSessionUid),
        );
        const client = collectMessages(clientWs);
        clientWs.send(
          JSON.stringify({
            type: TranscriptionStreamClientMessageType.AUTH,
            sessionToken: signToken({
              sessionUid: realSessionUid,
              clientId: 'observe-client',
              scopes: ['RECEIVE_TRANSCRIPTIONS'],
              exp: FAR_FUTURE,
            }),
          }),
        );
        await vi.waitFor(
          () => {
            expect(
              client.messages.find(
                (m) => m.type === TranscriptionStreamServerMessageType.AUTH_OK,
              ),
            ).toBeDefined();
          },
          { timeout: 15_000 },
        );

        const sourceWs = await server.fastify.injectWS(
          sourcePath(realSessionUid),
        );
        const source = collectMessages(sourceWs);
        sourceWs.send(
          JSON.stringify({
            type: TranscriptionStreamClientMessageType.AUTH,
            sessionToken: signToken({
              sessionUid: realSessionUid,
              clientId: 'observe-source',
              scopes: ['SEND_AUDIO'],
              exp: FAR_FUTURE,
            }),
          }),
        );

        // Wait for the source to fully complete its auth handshake (its own
        // initial sessionStatus snapshot has arrived) before terminating, so
        // the orchestrator has fully recorded the registration we're about
        // to undo.
        await vi.waitFor(
          () => {
            expect(
              source.messages.find(
                (m) =>
                  m.type ===
                  TranscriptionStreamServerMessageType.SESSION_STATUS,
              ),
            ).toBeDefined();
          },
          { timeout: 15_000 },
        );

        await vi.waitFor(
          () => {
            const status = [...client.messages]
              .reverse()
              .find(
                (m) =>
                  m.type ===
                  TranscriptionStreamServerMessageType.SESSION_STATUS,
              );
            expect(status).toMatchObject({ sourceDeviceConnected: true });
          },
          { timeout: 15_000 },
        );

        // Act
        source.stop();
        sourceWs.terminate();

        // Assert
        await vi.waitFor(
          () => {
            const status = [...client.messages]
              .reverse()
              .find(
                (m) =>
                  m.type ===
                  TranscriptionStreamServerMessageType.SESSION_STATUS,
              );
            expect(status).toMatchObject({ sourceDeviceConnected: false });
          },
          { timeout: 15_000 },
        );

        client.stop();
        clientWs.terminate();
      },
    );
  });

  describe('client role with live upstream', (it) => {
    it(
      'closes 1008 binary-not-allowed-for-role when an authed client sends binary',
      { timeout: 30_000 },
      async () => {
        // Arrange
        const ws = await server.fastify.injectWS(clientPath(realSessionUid));
        const { messages, stop } = collectMessages(ws);
        ws.send(
          JSON.stringify({
            type: TranscriptionStreamClientMessageType.AUTH,
            sessionToken: signToken({
              sessionUid: realSessionUid,
              clientId: 'client-binary',
              scopes: ['RECEIVE_TRANSCRIPTIONS'],
              exp: FAR_FUTURE,
            }),
          }),
        );
        await vi.waitFor(
          () => {
            expect(
              messages.find(
                (m) => m.type === TranscriptionStreamServerMessageType.AUTH_OK,
              ),
            ).toBeDefined();
          },
          { timeout: 15_000 },
        );

        // Act
        ws.send(Buffer.from([1, 2, 3]));
        const closed = await nextClose(ws);

        // Assert
        expect(closed.code).toBe(1008);
        expect(closed.reason).toBe('binary-not-allowed-for-role');
        stop();
      },
    );
  });
});
