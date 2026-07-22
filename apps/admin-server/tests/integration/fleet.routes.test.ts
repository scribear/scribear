import { afterAll, beforeAll, describe, expect, inject, vi } from 'vitest';

import type {
  NodeSnapshot,
  ProviderHealth,
  SessionSnapshot,
  TelemetryRedisClient,
  TranscriptionHostSnapshot,
} from '@scribear/scribear-redis';
import {
  NODE_INDEX_KEY,
  SESSION_INDEX_KEY,
  TRANSCRIPTION_HOST_INDEX_KEY,
  TRANSCRIPTION_HOST_TTL_MS,
  createTelemetryRedisClient,
  nodeSnapshotKey,
  sessionSnapshotKey,
  transcriptionHostSnapshotKey,
} from '@scribear/scribear-redis';

import type { FleetSnapshot } from '#src/server/shared/services/fleet-telemetry.service.js';
import { login, useServer } from '#tests/utils/use-server.js';

const URL = '/api/admin/v1/fleet';

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
        sessionUid: '00000000-0000-0000-0000-0000000fleet',
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
  });
});
