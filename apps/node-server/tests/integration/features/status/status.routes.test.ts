import crypto from 'node:crypto';
import { beforeAll, describe, expect, inject, vi } from 'vitest';
import type WebSocket from 'ws';

import { encodeAudioFrame } from '@scribear/audio-frame-protocol';
import {
  STATUS_ROUTE,
  TranscriptionStreamClientMessageType,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';
import type { SessionTokenPayload } from '@scribear/session-manager-schema';

import { seedSession } from '#tests/utils/seed-session.js';
import { TEST_SERVICE_API_KEY, useServer } from '#tests/utils/use-server.js';

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;
const DEBUG_SAMPLE_RATE = 48000;
const DEBUG_NUM_CHANNELS = 1;
const FAKE_SESSION_UID = '00000000-0000-0000-0000-000000000abc';

/** One latency distribution in the response (B1.4). */
interface LatencySeriesBody {
  measure: string;
  kind: string;
  count: number;
  sum: number;
  sampleCount: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

/** Response shape, narrowed to what these tests assert on. */
interface StatusBody {
  processUid: string;
  processStartedAt: string;
  generatedAt: string;
  summary: {
    activeSessionCount: number;
    decodeDropsTotal: number;
    authSuccessTotal: number;
    upstreamChurnTotal: number;
  };
  upstreamStateTransitions: { from: string; to: string; count: number }[];
  wsCloses: {
    code: number;
    reason: string;
    role: string;
    initiator: string;
    count: number;
  }[];
  authFailures: { reason: string; count: number }[];
  latency: LatencySeriesBody[];
  sessions: {
    sessionUid: string;
    sourceCount: number;
    subscriberCount: number;
    pendingChunkCount: number;
    upstreamState: string;
    upstreamRetryAttempt: number;
    latency: LatencySeriesBody[];
  }[];
  sessionsTruncated: boolean;
}

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

/** Wait for the WS to close and return the close code + reason. */
function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code: number, reason: Buffer) => {
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
}

describe('Status Routes', () => {
  const server = useServer();

  /**
   * `null` means "send no Authorization header at all" - distinct from
   * omitting the argument, which sends the valid key.
   */
  async function fetchStatus(
    authorization: string | null = `Bearer ${TEST_SERVICE_API_KEY}`,
  ) {
    return await server.fastify.inject({
      method: STATUS_ROUTE.method,
      url: STATUS_ROUTE.url,
      ...(authorization === null ? {} : { headers: { authorization } }),
    });
  }

  async function statusBody(): Promise<StatusBody> {
    const res = await fetchStatus();
    expect(res.statusCode).toBe(200);
    return res.json<StatusBody>();
  }

  /**
   * Open a transcription-stream connection and complete its auth handshake,
   * resolving once the server has acknowledged it - otherwise the counters we
   * assert on may not have been incremented yet.
   */
  async function connectAuthed(
    path: string,
    sessionUid: string,
    clientId: string,
    scopes: SessionTokenPayload['scopes'],
  ): Promise<WebSocket> {
    const ws = await server.fastify.injectWS(path);
    const seen: unknown[] = [];
    ws.on('message', (data: Buffer) => {
      try {
        seen.push(JSON.parse(data.toString('utf8')));
      } catch {
        /* ignore non-JSON frames */
      }
    });
    ws.send(
      JSON.stringify({
        type: TranscriptionStreamClientMessageType.AUTH,
        sessionToken: signToken({
          sessionUid,
          clientId,
          scopes,
          exp: FAR_FUTURE,
        }),
      }),
    );
    await vi.waitFor(
      () => {
        expect(
          seen.find(
            (m) =>
              (m as { type?: TranscriptionStreamServerMessageType }).type ===
              TranscriptionStreamServerMessageType.AUTH_OK,
          ),
        ).toBeDefined();
      },
      { timeout: 15_000 },
    );
    return ws;
  }

  let sessionUid: string;
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
    sessionUid = session.uid;
  });

  describe('auth', (it) => {
    it('returns 401 INVALID_SERVICE_KEY when no authorization header is sent', async () => {
      // Act
      const res = await fetchStatus(null);

      // Assert - the preHandler owns the missing-credential case, so this is a
      // 401 rather than the 400 a required header schema would produce.
      expect(res.statusCode).toBe(401);
      expect(res.json<{ code: string }>().code).toBe('INVALID_SERVICE_KEY');
    });

    it('returns 401 when the key is wrong', async () => {
      // Act
      const res = await fetchStatus('Bearer not-the-configured-key');

      // Assert
      expect(res.statusCode).toBe(401);
      expect(res.json<{ code: string }>().code).toBe('INVALID_SERVICE_KEY');
    });

    it('returns 400 when the header is not a Bearer credential at all', async () => {
      // Act
      const res = await fetchStatus(TEST_SERVICE_API_KEY);

      // Assert - shape is a request-validation failure, not an auth decision
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('VALIDATION_ERROR');
    });

    it('returns 200 with the correct key', async () => {
      // Act
      const res = await fetchStatus();

      // Assert
      expect(res.statusCode).toBe(200);
    });
  });

  describe('process identity', (it) => {
    it('reports a stable processUid and start time across reads', async () => {
      // Act
      const first = await statusBody();
      const second = await statusBody();

      // Assert - the sidecar differences counters only when these match, so a
      // changing uid within one process lifetime would break its rate maths.
      expect(first.processUid).toMatch(/^[0-9a-f-]{36}$/);
      expect(second.processUid).toBe(first.processUid);
      expect(second.processStartedAt).toBe(first.processStartedAt);
      expect(Date.parse(second.generatedAt)).toBeGreaterThanOrEqual(
        Date.parse(first.processStartedAt),
      );
    });
  });

  describe('auth failure counters', (it) => {
    it('counts a rejected token and the close it produced', async () => {
      // Arrange
      const before = await statusBody();
      const closeBefore =
        before.wsCloses.find(
          (c) =>
            c.code === 1008 &&
            c.reason === 'session-mismatch' &&
            c.initiator === 'server',
        )?.count ?? 0;
      const failureBefore =
        before.authFailures.find((f) => f.reason === 'session-mismatch')
          ?.count ?? 0;

      // Act - a token for a different session than the URL
      const ws = await server.fastify.injectWS(
        `/api/node-server/v1/transcription-stream/${FAKE_SESSION_UID}/source`,
      );
      ws.send(
        JSON.stringify({
          type: TranscriptionStreamClientMessageType.AUTH,
          sessionToken: signToken({
            sessionUid: '00000000-0000-0000-0000-000000000999',
            clientId: 'status-rejected',
            scopes: ['SEND_AUDIO'],
            exp: FAR_FUTURE,
          }),
        }),
      );
      const closed = await nextClose(ws);

      // Assert
      expect(closed.code).toBe(1008);
      const after = await statusBody();
      expect(
        after.authFailures.find((f) => f.reason === 'session-mismatch')?.count,
      ).toBe(failureBefore + 1);
      expect(
        after.wsCloses.find(
          (c) =>
            c.code === 1008 &&
            c.reason === 'session-mismatch' &&
            c.initiator === 'server',
        )?.count,
      ).toBe(closeBefore + 1);
    });
  });

  describe('live session gauges', (it) => {
    it(
      'reports source, subscriber and upstream state for an active session',
      { timeout: 60_000 },
      async () => {
        // Arrange - one source and two receive-only clients on one session.
        const base = `/api/node-server/v1/transcription-stream/${sessionUid}`;
        const authSuccessBefore = (await statusBody()).summary.authSuccessTotal;

        const sourceWs = await connectAuthed(
          `${base}/source`,
          sessionUid,
          'status-source',
          ['SEND_AUDIO'],
        );
        const clientA = await connectAuthed(
          `${base}/client`,
          sessionUid,
          'status-client-a',
          ['RECEIVE_TRANSCRIPTIONS'],
        );
        const clientB = await connectAuthed(
          `${base}/client`,
          sessionUid,
          'status-client-b',
          ['RECEIVE_TRANSCRIPTIONS'],
        );

        // Act / Assert
        await vi.waitFor(
          async () => {
            const body = await statusBody();
            const session = body.sessions.find(
              (s) => s.sessionUid === sessionUid,
            );
            expect(session).toBeDefined();
            expect(session?.sourceCount).toBe(1);
            // All three connections count: the fan-out cost of a room is
            // dominated by receive-only clients, which never reach the
            // orchestrator and so are invisible to `sourceCount`.
            expect(session?.subscriberCount).toBe(3);
            expect(body.summary.activeSessionCount).toBeGreaterThanOrEqual(1);
            expect(body.summary.authSuccessTotal).toBe(authSuccessBefore + 3);
            expect(body.sessionsTruncated).toBe(false);
          },
          { timeout: 15_000 },
        );

        // The upstream reaches OPEN once the debug provider accepts the
        // session; until then it is legitimately CONNECTING/HANDSHAKING.
        await vi.waitFor(
          async () => {
            const body = await statusBody();
            const session = body.sessions.find(
              (s) => s.sessionUid === sessionUid,
            );
            expect(session?.upstreamState).toBe('OPEN');
            expect(session?.upstreamRetryAttempt).toBe(0);
          },
          { timeout: 30_000 },
        );

        // A healthy upstream still records its IDLE -> CONNECTING -> ... walk.
        const withUpstream = await statusBody();
        expect(withUpstream.upstreamStateTransitions.length).toBeGreaterThan(0);

        // Act - a malformed SAFP frame is dropped rather than forwarded (U2).
        const dropsBefore = withUpstream.summary.decodeDropsTotal;
        sourceWs.send(Buffer.from([0x00, 0x01, 0x02, 0x03]));
        await vi.waitFor(
          async () => {
            const body = await statusBody();
            expect(body.summary.decodeDropsTotal).toBe(dropsBefore + 1);
          },
          { timeout: 15_000 },
        );

        // A well-formed frame is not counted as a drop.
        const dropsAfterBad = (await statusBody()).summary.decodeDropsTotal;
        sourceWs.send(
          Buffer.from(
            encodeAudioFrame(
              { chunkId: crypto.randomUUID() },
              Buffer.alloc(64),
            ),
          ),
        );
        await vi.waitFor(
          async () => {
            const body = await statusBody();
            expect(body.summary.decodeDropsTotal).toBe(dropsAfterBad);
          },
          { timeout: 5_000 },
        );

        // Assert - latency blocks survive response serialization (B1.4).
        // Whether the debug provider has echoed a transcript back yet is
        // timing-dependent, so this asserts the shape rather than a count:
        // percentiles are `Type.Number()` where the rest of this response is
        // `Type.Integer()`, and getting that wrong strips them silently.
        const withLatency = await statusBody();
        const session = withLatency.sessions.find(
          (s) => s.sessionUid === sessionUid,
        );
        expect(Array.isArray(session?.latency)).toBe(true);
        for (const series of [
          ...withLatency.latency,
          ...(session?.latency ?? []),
        ]) {
          expect(series.sampleCount).toBeGreaterThan(0);
          expect(series.p50).toBeLessThanOrEqual(series.p95);
          expect(series.p95).toBeLessThanOrEqual(series.p99);
          expect(series.p99).toBeLessThanOrEqual(series.max);
        }

        clientA.terminate();
        clientB.terminate();
        sourceWs.terminate();

        // Assert - the session's entry disappears once every connection goes,
        // so `sessions[]` tracks live state rather than growing forever.
        await vi.waitFor(
          async () => {
            const body = await statusBody();
            expect(
              body.sessions.find((s) => s.sessionUid === sessionUid),
            ).toBeUndefined();
          },
          { timeout: 15_000 },
        );
      },
    );
  });
});
