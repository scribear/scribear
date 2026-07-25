import { afterAll, beforeAll, describe, expect, inject, vi } from 'vitest';

import type {
  FleetEvent,
  NodeSnapshot,
  ProviderHealth,
  SessionAudioSnapshot,
  SessionSnapshot,
  TelemetryRedisClient,
  TranscriptionHostSnapshot,
} from '@scribear/scribear-redis';
import {
  FLEET_EVENTS_CHANNEL_KEY,
  NODE_INDEX_KEY,
  SESSION_INDEX_KEY,
  TRANSCRIPTION_HOST_INDEX_KEY,
  TRANSCRIPTION_HOST_TTL_MS,
  TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
  createTelemetryRedisClient,
  nodeSnapshotKey,
  sessionSnapshotKey,
  transcriptionHostSnapshotKey,
  transcriptionSessionAudioKey,
} from '@scribear/scribear-redis';

import type { FleetSnapshot } from '#src/server/shared/services/fleet-telemetry.service.js';
import { login, useServer } from '#tests/utils/use-server.js';

const URL = '/api/admin/v1/fleet';
const STREAM_URL = '/api/admin/v1/fleet/stream';

interface FleetBody {
  ok: boolean;
  data?: FleetSnapshot;
  error?: { code: string };
}

/** A client that has finished connecting, matching the publishers' own pattern. */
async function connectedClient(): Promise<TelemetryRedisClient> {
  const client = createTelemetryRedisClient(inject('redisUrl'));
  await new Promise<void>((resolve) => client.once('ready', resolve));
  return client;
}

function fakeProviderHealth(
  overrides: Partial<ProviderHealth> = {},
): ProviderHealth {
  return {
    providerUid: 'whisper-local',
    kind: 'local',
    status: 'ok',
    activeSessions: 1,
    model: 'base.en',
    modelLoaded: true,
    owningWorkers: [],
    endpoint: null,
    reachable: null,
    probeLatencyMs: null,
    detail: null,
    ...overrides,
  };
}

describe('Fleet route, telemetry disabled (default: REDIS_URL unset)', () => {
  const server = useServer();
  let cookie = '';

  beforeAll(async () => {
    cookie = (await login(server.fastify)).cookie;
  });

  describe('auth', (it) => {
    it('requires a session', async () => {
      const res = await server.fastify.inject({ method: 'GET', url: URL });

      expect(res.statusCode).toBe(401);
    });

    it('requires a session on the stream route too', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: STREAM_URL,
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('availability', (it) => {
    it('answers 503 TELEMETRY_UNAVAILABLE rather than an empty fleet', async () => {
      // Empty and "not configured" must be distinguishable: an empty 200
      // would be indistinguishable from a fleet that is genuinely idle.
      const res = await server.fastify.inject({
        method: 'GET',
        url: URL,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json<FleetBody>().error?.code).toBe('TELEMETRY_UNAVAILABLE');
    });

    it('answers 503 TELEMETRY_UNAVAILABLE on the stream route, not a hijacked connection', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: STREAM_URL,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json<FleetBody>().error?.code).toBe('TELEMETRY_UNAVAILABLE');
    });
  });
});

describe('Fleet route, telemetry degraded (unreachable Redis)', (it) => {
  const server = useServer({
    // A port nothing listens on: with the telemetry client's offline queue
    // disabled, the first command fails immediately rather than hanging for
    // a connection that will never succeed.
    fleetTelemetryConfig: { redisUrl: 'redis://127.0.0.1:1' },
  });
  let cookie = '';

  beforeAll(async () => {
    cookie = (await login(server.fastify)).cookie;
  });

  it('answers 503 TELEMETRY_DEGRADED, not 500', async () => {
    const res = await server.fastify.inject({
      method: 'GET',
      url: URL,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json<FleetBody>().error?.code).toBe('TELEMETRY_DEGRADED');
  });
});

describe('Fleet route wired to a real fleet backplane', () => {
  let redis: TelemetryRedisClient;
  const server = useServer({
    fleetTelemetryConfig: { redisUrl: inject('redisUrl') },
  });
  let cookie = '';

  async function fetchFleet() {
    const res = await server.fastify.inject({
      method: 'GET',
      url: URL,
      headers: { cookie },
    });
    return { res, body: res.json<FleetBody>() };
  }

  beforeAll(async () => {
    redis = await connectedClient();
    await redis.flushall();
    cookie = (await login(server.fastify)).cookie;

    // fleetTelemetryService's Redis client is built lazily, on the first
    // request that resolves it — the client's offline queue is disabled, so a
    // request racing ahead of the connection's own `ready` event 503s once.
    // That is the documented, self-healing "telemetry degraded" behavior, not
    // a bug; absorb the one-time race here rather than in every test below.
    await vi.waitFor(async () => {
      const { res } = await fetchFleet();
      expect(res.statusCode).toBe(200);
    });
  });

  afterAll(async () => {
    await redis.quit();
  });

  describe('empty fleet', (it) => {
    it('returns 200 with everything empty when nothing has published', async () => {
      const { res, body } = await fetchFleet();

      expect(res.statusCode).toBe(200);
      expect(body.data).toMatchObject({
        nodes: [],
        sessions: [],
        transcriptionHosts: [],
        providers: [],
        sessionAudio: [],
      });
    });
  });

  describe('live fleet', (it) => {
    it('reads a published node, session and provider from Redis', async () => {
      // Arrange - published directly, bypassing the publishers: this test
      // exercises the reader's contract with the key schema, not the
      // publishers (they have their own integration suites).
      const now = Date.now();
      const node: NodeSnapshot = {
        updatedAt: now,
        nodeInstanceId: 'fleet-test-node',
        processUid: '00000000-0000-0000-0000-0000000000ff',
        processStartedAt: new Date(now - 1000).toISOString(),
        generatedAt: new Date(now).toISOString(),
        summary: {
          activeSessionCount: 1,
          decodeDropsTotal: 0,
          pendingChunkEvictionsTotal: 0,
          upstreamChurnTotal: 0,
          authSuccessTotal: 0,
          authTimeoutsTotal: 0,
          orchestratorFailuresTotal: 0,
          latencySamplesTotal: 0,
          latencyE2eUnavailableTotal: 0,
          latencyE2eNegativeTotal: 0,
          latencyUnmatchedChunkTotal: 0,
        },
        upstreamStateTransitions: [],
        wsCloses: [],
        latency: [],
        authFailures: [],
      };
      await redis.set(
        nodeSnapshotKey(node.nodeInstanceId),
        JSON.stringify(node),
      );
      await redis.zadd(NODE_INDEX_KEY, now, node.nodeInstanceId);

      const session: SessionSnapshot = {
        // Hex, unlike the readable `...0000000fleet` this used to be:
        // `sessionUid` declares `format: 'uuid'`, typebox enforces it, and
        // the sessions index hard-drops what fails validation now.
        sessionUid: '00000000-0000-0000-0000-00000000f1ee',
        providerKey: 'whisper',
        sourceCount: 1,
        subscriberCount: 1,
        pendingChunkCount: 0,
        upstreamState: 'OPEN',
        upstreamRetryAttempt: 0,
        latency: [],
        updatedAt: now,
        nodeInstanceId: node.nodeInstanceId,
        processUid: node.processUid,
      };
      await redis.set(
        sessionSnapshotKey(session.sessionUid),
        JSON.stringify(session),
      );
      await redis.zadd(SESSION_INDEX_KEY, now, session.sessionUid);

      const host: TranscriptionHostSnapshot = {
        updatedAt: now,
        transcriptionHost: 'fleet-test-ts',
        processUid: '00000000-0000-0000-0000-0000000000aa',
        processStartedAt: new Date(now - 1000).toISOString(),
        numWorkers: 1,
        invalidProviderKeyRejects: 0,
        workers: [],
        providers: { whisper: fakeProviderHealth() },
      };
      await redis.set(
        transcriptionHostSnapshotKey(host.transcriptionHost),
        JSON.stringify(host),
      );
      await redis.zadd(
        TRANSCRIPTION_HOST_INDEX_KEY,
        now,
        host.transcriptionHost,
      );

      // Act
      const { res, body } = await fetchFleet();

      // Assert
      expect(res.statusCode).toBe(200);
      expect(body.data?.nodes).toEqual([node]);
      expect(body.data?.sessions).toEqual([session]);
      expect(body.data?.transcriptionHosts).toEqual([host]);
      expect(body.data?.providers).toEqual([
        {
          providerKey: 'whisper',
          status: 'ok',
          activeSessions: 1,
          hosts: [
            {
              transcriptionHost: 'fleet-test-ts',
              health: host.providers['whisper'],
            },
          ],
        },
      ]);
    });

    it('does not list a host whose snapshot has expired past its TTL', async () => {
      // Arrange - indexed long enough ago that ZRANGEBYSCORE excludes it,
      // matching what a dead host looks like after its heartbeat stops.
      const staleHost = 'fleet-test-ts-dead';
      await redis.zadd(
        TRANSCRIPTION_HOST_INDEX_KEY,
        Date.now() - TRANSCRIPTION_HOST_TTL_MS - 1000,
        staleHost,
      );

      // Act
      const { body } = await fetchFleet();

      // Assert
      expect(
        body.data?.transcriptionHosts.some(
          (h) => h.transcriptionHost === staleHost,
        ),
      ).toBe(false);
    });

    it('reads a published audio stage graph from the audio index', async () => {
      // Arrange — published directly, bypassing the publisher, to exercise the
      // reader's contract with the key schema. Two points, so both nullability
      // directions cross the wire in one read: a metered source that runs no
      // detector (`vad: null`, the old top-level `vadStats: null` case) and a
      // detector that meters nothing (`levels: null`).
      const now = Date.now();
      const audio: SessionAudioSnapshot = {
        updatedAt: now,
        stages: [
          {
            stage: 'ingress',
            label: 'Source ingress',
            depth: 1,
            inputs: [],
            levels: {
              rmsDbfs: -21.3,
              peakDbfs: -9.8,
              clippingPct: 0,
              silence: false,
              noiseFloorDbfs: -62.0,
            },
            vad: null,
            audioSeconds: 83.5,
          },
          {
            stage: 'vad',
            label: 'VAD (Silero)',
            depth: 2,
            inputs: ['ingress'],
            levels: null,
            vad: {
              vadEnabled: true,
              speechActiveRatio: 0.55,
              segmentCount: 5,
              meanSegmentDurationSec: 0.9,
              speechToPauseRatio: 1.2,
              snrDb: 22.1,
            },
            audioSeconds: 41.0,
          },
        ],
        sessionUid: '00000000-0000-0000-0000-000audio0001',
        roomUid: null,
        transcriptionHost: 'fleet-test-ts',
      };
      await redis.set(
        transcriptionSessionAudioKey(audio.sessionUid),
        JSON.stringify(audio),
      );
      await redis.zadd(
        TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
        now,
        audio.sessionUid,
      );

      // Act
      const { body } = await fetchFleet();

      // Assert — round-trips through validation and the envelope unchanged,
      // `depth` and `inputs` included: they are what place a point in the
      // pipeline, so the graph is only readable if serialization keeps them.
      expect(body.data?.sessionAudio).toEqual([audio]);
      expect(body.data?.sessionAudio[0]?.stages[1]?.inputs).toEqual([
        'ingress',
      ]);
    });

    it('drops an audio value the schema rejects rather than 503ing the whole fleet', async () => {
      // Arrange — the flat pre-stage-graph payload, which is what a publisher
      // that has not been rolled forward writes. §12.4 ships no compatibility
      // shim, so this has to be rejected; a healthy session published beside it
      // must still be served, or one stale publisher would cost the operator
      // every session's audio telemetry rather than its own.
      const now = Date.now();
      const healthyUid = '00000000-0000-0000-0000-000audio0003';
      const healthy: SessionAudioSnapshot = {
        updatedAt: now,
        stages: [
          {
            stage: 'asr_input',
            label: 'ASR input (worker decode)',
            depth: 1,
            inputs: [],
            levels: null,
            vad: null,
            audioSeconds: 12.5,
          },
        ],
        sessionUid: healthyUid,
        roomUid: null,
        transcriptionHost: 'fleet-test-ts',
      };
      await redis.set(
        transcriptionSessionAudioKey(healthyUid),
        JSON.stringify(healthy),
      );
      await redis.zadd(TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY, now, healthyUid);

      const staleShapeUid = '00000000-0000-0000-0000-000audio0002';
      await redis.set(
        transcriptionSessionAudioKey(staleShapeUid),
        JSON.stringify({
          rmsDbfs: -21.3,
          peakDbfs: -9.8,
          clippingPct: 0,
          silence: false,
          noiseFloorDbfs: -62.0,
          updatedAt: now,
          vadStats: null,
          sessionUid: staleShapeUid,
          roomUid: null,
          transcriptionHost: 'fleet-test-ts',
        }),
      );
      await redis.zadd(
        TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
        now,
        staleShapeUid,
      );

      // Act
      const { res, body } = await fetchFleet();

      // Assert
      expect(res.statusCode).toBe(200);
      expect(
        body.data?.sessionAudio.some((a) => a.sessionUid === staleShapeUid),
      ).toBe(false);
      expect(body.data?.sessionAudio).toContainEqual(healthy);
    });
  });

  describe('stream', (it) => {
    /**
     * Connects to `/fleet/stream` and resolves the first SSE `data:` frame
     * once one arrives. `payloadAsStream` is what lets `inject()` resolve as
     * soon as headers are written (light-my-request's `Response.writeHead`
     * pushes the payload the moment `hijack()`'d code calls it) rather than
     * waiting for the response to end, which - by design - it never does.
     */
    async function openStream() {
      const res = await server.fastify.inject({
        method: 'GET',
        url: STREAM_URL,
        headers: { cookie },
        payloadAsStream: true,
      });
      const stream = res.stream();
      const frames = new Array<FleetEvent>();
      let buffer = '';
      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.startsWith('data: ')) {
            frames.push(JSON.parse(frame.slice('data: '.length)) as FleetEvent);
          }
        }
      });
      return {
        res,
        stream,
        nextFrame: () =>
          vi.waitFor(() => {
            const frame = frames.shift();
            if (frame === undefined) throw new Error('no frame yet');
            return frame;
          }),
      };
    }

    it('streams a session status delta published on the events channel', async () => {
      // Arrange
      const { res, stream, nextFrame } = await openStream();
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');

      const event: FleetEvent = {
        t: 'session',
        sessionUid: '00000000-0000-0000-0000-0000000str3a',
        transcriptionServiceConnected: true,
        sourceDeviceConnected: true,
        at: Date.now(),
      };

      // Act
      await redis.publish(FLEET_EVENTS_CHANNEL_KEY, JSON.stringify(event));

      // Assert
      expect(await nextFrame()).toStrictEqual(event);

      // Cleanup
      stream.destroy();
    });

    it('fans one published event out to every connected stream', async () => {
      // Arrange
      const first = await openStream();
      const second = await openStream();
      const event: FleetEvent = {
        t: 'session',
        sessionUid: '00000000-0000-0000-0000-0000000str3b',
        transcriptionServiceConnected: false,
        sourceDeviceConnected: false,
        at: Date.now(),
      };

      // Act
      await redis.publish(FLEET_EVENTS_CHANNEL_KEY, JSON.stringify(event));

      // Assert
      expect(await first.nextFrame()).toStrictEqual(event);
      expect(await second.nextFrame()).toStrictEqual(event);

      // Cleanup
      first.stream.destroy();
      second.stream.destroy();
    });
  });
});
