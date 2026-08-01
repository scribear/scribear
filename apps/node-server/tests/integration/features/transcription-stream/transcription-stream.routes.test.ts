import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, inject, vi } from 'vitest';
import type WebSocket from 'ws';

import { encodeAudioFrame } from '@scribear/audio-frame-protocol';
import {
  TranscriptionStreamClientMessageType,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';
import { createSessionManagerClient } from '@scribear/session-manager-client';
import type { SessionTokenPayload } from '@scribear/session-manager-schema';

import { seedSession } from '#tests/utils/seed-session.js';
import { TEST_SERVICE_API_KEY, useServer } from '#tests/utils/use-server.js';

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;
const DEBUG_SAMPLE_RATE = 48000;
const DEBUG_NUM_CHANNELS = 1;
const FAKE_SESSION_UID = '00000000-0000-0000-0000-000000000abc';

const TEST_AUDIO_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../test_audio_files/musical_chords/mono_f64le.wav',
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
 * A decoded server frame. `type` is the enum rather than a bare string so
 * comparisons against `TranscriptionStreamServerMessageType` members are
 * type-checked instead of tripping `no-unsafe-enum-comparison`.
 */
interface ServerMessage {
  type: TranscriptionStreamServerMessageType;
  [key: string]: unknown;
}

/**
 * Collect all server messages from the WS into a stable array. Returns the
 * array (mutated as messages arrive) plus an unsubscribe function.
 */
function collectMessages(ws: WebSocket): {
  messages: ServerMessage[];
  stop: () => void;
} {
  const messages: ServerMessage[] = [];
  const handler = (data: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const parsed = decodeJson(data) as ServerMessage;
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

  describe('pre-auth binary handling (H1)', (it) => {
    /** Reads the binaryBeforeAuthDropsTotal counter off /status. */
    async function readBinaryBeforeAuthDrops(): Promise<number> {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/node-server/v1/status',
        headers: { authorization: `Bearer ${TEST_SERVICE_API_KEY}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      return body.summary.binaryBeforeAuthDropsTotal;
    }

    /**
     * Resolves if the socket is still open after `ms`, rejects if it closes.
     * The pre-auth binary guard must DROP, not close — a close here is the H1
     * regression (the old 1008 `binary-before-auth` that reconnect-looped the
     * kiosk).
     */
    function expectStaysOpen(ws: WebSocket, ms: number): Promise<void> {
      return new Promise((resolve, reject) => {
        const onClose = (code: number, reason: Buffer) => {
          cleanup();
          reject(
            new Error(
              `socket closed unexpectedly: ${String(code)} ${reason.toString('utf8')}`,
            ),
          );
        };
        const timer = setTimeout(() => {
          cleanup();
          resolve();
        }, ms);
        function cleanup() {
          clearTimeout(timer);
          ws.off('close', onClose);
        }
        ws.on('close', onClose);
      });
    }

    it(
      'drops pre-auth binary without closing, then auth and audio still flow',
      { timeout: 60_000 },
      async () => {
        // Arrange
        const before = await readBinaryBeforeAuthDrops();
        const ws = await server.fastify.injectWS(sourcePath(realSessionUid));
        const { messages, stop } = collectMessages(ws);

        // Act 1 — send two binary frames BEFORE auth. Old behaviour closed
        // 1008 `binary-before-auth` on the first and reconnect-looped; new
        // behaviour drops and counts, and the socket must stay open.
        ws.send(
          Buffer.from(
            encodeAudioFrame({ chunkId: crypto.randomUUID() }, TEST_AUDIO),
          ),
        );
        ws.send(
          Buffer.from(
            encodeAudioFrame({ chunkId: crypto.randomUUID() }, TEST_AUDIO),
          ),
        );

        // Act 2 — authenticate immediately. The pre-auth binaries were
        // dropped; AUTH now runs and the auth-timeout watchdog still has its
        // full window (the binaries did not consume any of it).
        ws.send(
          JSON.stringify({
            type: TranscriptionStreamClientMessageType.AUTH,
            sessionToken: signToken({
              sessionUid: realSessionUid,
              clientId: 'preauth-src',
              scopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
              exp: FAR_FUTURE,
            }),
          }),
        );

        // Assert 1 — no close from the pre-auth binaries. A 1008 close would
        // have fired within milliseconds, so one second is a strong signal.
        await expectStaysOpen(ws, 1000);

        // Assert 2 — the socket survived, so AUTH_OK arrives.
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

        // Assert 3 — the dropped frames were counted.
        const after = await readBinaryBeforeAuthDrops();
        expect(after).toBeGreaterThanOrEqual(before + 2);

        // Act 3 + Assert 4 — wait for the upstream to open, send audio, and
        // confirm a transcript comes back. Proves the pre-auth drop did not
        // leave the connection in a state that blocks real audio.
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

        ws.send(
          Buffer.from(
            encodeAudioFrame({ chunkId: crypto.randomUUID() }, TEST_AUDIO),
          ),
        );

        await vi.waitFor(
          () => {
            const transcripts = messages.filter(
              (m) => m.type === TranscriptionStreamServerMessageType.TRANSCRIPT,
            );
            expect(transcripts.length).toBeGreaterThan(0);
          },
          { timeout: 30_000 },
        );

        stop();
        ws.terminate();
      },
    );
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
          (m) => m.type === TranscriptionStreamServerMessageType.SESSION_STATUS,
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
      'answers a timeSyncPing with a timeSyncPong echoing t0',
      { timeout: 30_000 },
      async () => {
        // Arrange
        const ws = await server.fastify.injectWS(sourcePath(realSessionUid));
        const { messages, stop } = collectMessages(ws);

        // Act - a clock-sync probe does not require auth
        const t0 = 1_234_567;
        ws.send(
          JSON.stringify({
            type: TranscriptionStreamClientMessageType.TIME_SYNC_PING,
            t0,
          }),
        );

        // Assert
        await vi.waitFor(
          () => {
            const pong = messages.find(
              (m) =>
                m.type === TranscriptionStreamServerMessageType.TIME_SYNC_PONG,
            );
            expect(pong).toMatchObject({
              type: TranscriptionStreamServerMessageType.TIME_SYNC_PONG,
              t0,
              t1: expect.any(Number),
            });
          },
          { timeout: 10_000 },
        );

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

        // Act - send a real WAV file the AudioDecoder can parse, wrapped in a
        // SAFP frame exactly as the kiosk (via the node server) would.
        ws.send(
          Buffer.from(
            encodeAudioFrame({ chunkId: crypto.randomUUID() }, TEST_AUDIO),
          ),
        );

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
            // Require a *non-zero* processed duration: the debug provider emits
            // "Processed 0.0000 seconds" on its periodic tick even with no
            // audio, so only a positive value proves the SAFP-framed audio
            // actually round-tripped through the upstream.
            const processed = /Processed ([\d.]+) seconds of audio/.exec(
              allText,
            );
            expect(processed).not.toBeNull();
            expect(Number(processed?.[1] ?? 0)).toBeGreaterThan(0);
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
              (m) => m.type === TranscriptionStreamServerMessageType.TRANSCRIPT,
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

  // The bug this covers: `registerSource` was the only thing that ever built
  // `SessionState`, so a room whose viewers joined before (or without) a kiosk
  // had nobody fetching its config, nobody arming an end timer, and no
  // `sessionEnded` ever published. Viewers sat on stale captions until a token
  // refresh happened to be rejected - up to half the token lifetime.
  describe('viewer-only session end (no source attached)', (it) => {
    it(
      'sends sessionEnded and closes 1000 when the session is ended early',
      { timeout: 60_000 },
      async () => {
        // Arrange - a session of its own, so ending it cannot disturb the
        // shared streaming fixture. On-demand sessions are created open-ended
        // (`scheduledEndTime` is the next non-AUTO start, absent here), so
        // nothing is armed until the early end moves `effectiveEnd` into the
        // past - the `end_override = now` case.
        const session = await seedSession({
          sessionManagerBaseUrl: inject('sessionManagerBaseUrl'),
          adminApiKey: inject('adminApiKey'),
          transcriptionProviderId: 'debug',
          transcriptionStreamConfig: {
            sample_rate: DEBUG_SAMPLE_RATE,
            num_channels: DEBUG_NUM_CHANNELS,
          },
        });

        const ws = await server.fastify.injectWS(clientPath(session.uid));
        const { messages, stop } = collectMessages(ws);
        ws.send(
          JSON.stringify({
            type: TranscriptionStreamClientMessageType.AUTH,
            sessionToken: signToken({
              sessionUid: session.uid,
              clientId: 'lonely-viewer',
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

        // Assert - the viewer costs the transcription service nothing: no
        // upstream was dialed, so the session holds no orchestrator state and
        // does not appear in /status. Opening an upstream for an audio-less
        // connection is the fault e80eea2 was written for.
        const status = await server.fastify.inject({
          method: 'GET',
          url: '/api/node-server/v1/status',
          headers: { authorization: `Bearer ${TEST_SERVICE_API_KEY}` },
        });
        expect(status.statusCode).toBe(200);
        const sessions = status.json<{
          sessions: { sessionUid: string }[];
        }>().sessions;
        expect(sessions.map((s) => s.sessionUid)).not.toContain(session.uid);

        // Act - end the session out from under the viewer.
        const closed = nextClose(ws);
        const sm = createSessionManagerClient(inject('sessionManagerBaseUrl'));
        const ended = await sm.scheduleManagement.endSessionEarly({
          body: { sessionUid: session.uid },
          headers: { authorization: `Bearer ${inject('adminApiKey')}` },
        });
        expect(ended[1]).toBeNull();
        expect(ended[0]?.status).toBe(200);

        // Assert - the config bump reaches the end-watch's long-poll, which
        // sees an `effectiveEnd` already in the past and publishes at once.
        await vi.waitFor(
          () => {
            expect(
              messages.find(
                (m) =>
                  m.type === TranscriptionStreamServerMessageType.SESSION_ENDED,
              ),
            ).toBeDefined();
          },
          { timeout: 20_000 },
        );
        await expect(closed).resolves.toMatchObject({
          code: 1000,
          reason: 'session-ended',
        });

        stop();
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
