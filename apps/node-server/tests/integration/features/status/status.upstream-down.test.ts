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

/**
 * Per the orchestrator's `MAX_PENDING_CHUNKS`. Restated rather than imported
 * because it is deliberately private: the test asserts on the observable
 * consequence (evictions counted, gauge pinned at the cap), not on the
 * constant.
 */
const MAX_PENDING_CHUNKS = 2000;
const FRAMES_TO_SEND = MAX_PENDING_CHUNKS + 100;

interface StatusBody {
  summary: {
    upstreamChurnTotal: number;
    pendingChunkEvictionsTotal: number;
  };
  upstreamStateTransitions: { from: string; to: string; count: number }[];
  sessions: {
    sessionUid: string;
    pendingChunkCount: number;
    upstreamState: string;
    upstreamRetryAttempt: number;
  }[];
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

/**
 * The N1 gate from the monitoring plan, and the reason B1.1 exists: with the
 * Transcription Service unreachable, node-server's upstream flaps, and the
 * status endpoint has to show it. Before this endpoint the only trace was log
 * text the sidecar had to parse.
 *
 * Port 1 is reserved and unbound, so connections are refused immediately
 * rather than hanging until a timeout.
 */
describe('Status Routes with an unreachable upstream', () => {
  const server = useServer({
    transcriptionServiceClientConfig: { baseUrl: 'http://127.0.0.1:1' },
  });

  async function statusBody(): Promise<StatusBody> {
    const res = await server.fastify.inject({
      method: STATUS_ROUTE.method,
      url: STATUS_ROUTE.url,
      headers: { authorization: `Bearer ${TEST_SERVICE_API_KEY}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json<StatusBody>();
  }

  let sessionUid: string;
  let sourceWs: WebSocket;

  beforeAll(async () => {
    const session = await seedSession({
      sessionManagerBaseUrl: inject('sessionManagerBaseUrl'),
      adminApiKey: inject('adminApiKey'),
      transcriptionProviderId: 'debug',
      transcriptionStreamConfig: { sample_rate: 48000, num_channels: 1 },
    });
    sessionUid = session.uid;

    sourceWs = await server.fastify.injectWS(
      `/api/node-server/v1/transcription-stream/${sessionUid}/source`,
    );
    const seen: unknown[] = [];
    sourceWs.on('message', (data: Buffer) => {
      try {
        seen.push(JSON.parse(data.toString('utf8')));
      } catch {
        /* ignore non-JSON frames */
      }
    });
    sourceWs.send(
      JSON.stringify({
        type: TranscriptionStreamClientMessageType.AUTH,
        sessionToken: signToken({
          sessionUid,
          clientId: 'upstream-down-source',
          scopes: ['SEND_AUDIO'],
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
  }, 60_000);

  describe('upstream churn (N1)', (it) => {
    it(
      'reports WAITING_RETRY and a climbing churn counter',
      { timeout: 60_000 },
      async () => {
        // Act / Assert - the upstream cycles CONNECTING -> WAITING_RETRY, and
        // every re-entry into WAITING_RETRY is one unit of churn.
        await vi.waitFor(
          async () => {
            const body = await statusBody();
            expect(body.summary.upstreamChurnTotal).toBeGreaterThan(0);
            expect(
              body.upstreamStateTransitions.find(
                (t) => t.to === 'WAITING_RETRY',
              ),
            ).toBeDefined();
          },
          { timeout: 30_000 },
        );

        // The per-session gauge names the session that is failing, which the
        // process-wide counter cannot.
        await vi.waitFor(
          async () => {
            const body = await statusBody();
            const session = body.sessions.find(
              (s) => s.sessionUid === sessionUid,
            );
            expect(session?.upstreamState).toBe('WAITING_RETRY');
            expect(session?.upstreamRetryAttempt).toBeGreaterThan(0);
          },
          { timeout: 30_000 },
        );
      },
    );
  });

  describe('pending-chunk evictions (N3)', (it) => {
    it(
      'counts evictions once the per-session cap is reached',
      { timeout: 60_000 },
      async () => {
        // Arrange - correlation entries are recorded on ingress, before the
        // upstream send, so this exercises the cap without a live provider
        // (and without a transcript ever arriving to prune the map).
        const before = (await statusBody()).summary.pendingChunkEvictionsTotal;

        // Act
        for (let i = 0; i < FRAMES_TO_SEND; i += 1) {
          sourceWs.send(
            Buffer.from(
              encodeAudioFrame(
                { chunkId: crypto.randomUUID() },
                Buffer.alloc(8),
              ),
            ),
          );
        }

        // Assert - the gauge pins at the cap rather than growing, and the
        // overflow is counted. This is also the first evidence the cap is
        // reachable at all; before B1.1 the eviction was entirely silent.
        await vi.waitFor(
          async () => {
            const body = await statusBody();
            expect(
              body.summary.pendingChunkEvictionsTotal,
            ).toBeGreaterThanOrEqual(
              before + FRAMES_TO_SEND - MAX_PENDING_CHUNKS,
            );
            expect(
              body.sessions.find((s) => s.sessionUid === sessionUid)
                ?.pendingChunkCount,
            ).toBe(MAX_PENDING_CHUNKS);
          },
          { timeout: 30_000 },
        );
      },
    );
  });
});
