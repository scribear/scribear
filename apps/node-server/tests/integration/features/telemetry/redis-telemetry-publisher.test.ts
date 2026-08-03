import { afterAll, beforeAll, describe, expect, inject, vi } from 'vitest';

import type {
  StatusProcess,
  StatusSession,
} from '@scribear/node-server-schema';
import {
  FLEET_EVENTS_CHANNEL_KEY,
  NODE_INDEX_KEY,
  NODE_TTL_MS,
  SESSION_INDEX_KEY,
  type TelemetryRedisClient,
  createTelemetryRedisClient,
  nodeSnapshotKey,
  sessionRouteKey,
  sessionSnapshotKey,
} from '@scribear/scribear-redis';

import createServer from '#src/server/create-server.js';
import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { RedisTelemetryPublisher } from '#src/server/features/telemetry/redis-telemetry-publisher.service.js';
import { FleetStatusDeltaChannel } from '#src/server/features/transcription-stream/events/fleet-status-delta.events.js';
import { EventBusService } from '#src/server/shared/services/event-bus.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';
import { buildTestAppConfig } from '#tests/utils/use-server.js';

const NODE_INSTANCE_ID = 'test-node-a';
const WIRED_INSTANCE_ID = 'test-node-wired';
const SESSION_UID = '00000000-0000-0000-0000-0000000b1700';
const ROOM_UID = '00000000-0000-0000-0000-0000000b00f1';
const PROCESS_UID = '00000000-0000-0000-0000-0000000000ff';

/**
 * A client that has finished connecting. The telemetry client refuses to queue
 * commands while disconnected, so a command issued straight after construction
 * races the connection - the same reason the publisher beats on `ready`.
 */
async function connectedClient(): Promise<TelemetryRedisClient> {
  const client = createTelemetryRedisClient(inject('redisUrl'));
  await new Promise<void>((resolve) => client.once('ready', resolve));
  return client;
}

function fakeProcess(): StatusProcess {
  return {
    processUid: PROCESS_UID,
    processStartedAt: '2026-07-20T00:00:00.000Z',
    generatedAt: '2026-07-20T00:00:10.000Z',
    summary: {
      activeSessionCount: 1,
      decodeDropsTotal: 0,
      binaryBeforeAuthDropsTotal: 0,
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
}

function fakeSession(): StatusSession {
  return {
    sessionUid: SESSION_UID,
    roomUid: ROOM_UID,
    providerKey: 'debug',
    sourceCount: 1,
    subscriberCount: 2,
    pendingChunkCount: 0,
    upstreamState: 'OPEN',
    upstreamRetryAttempt: 0,
    latency: [],
  };
}

/**
 * Exercises the publisher against a real Redis rather than a fake client.
 *
 * The unit suite already asserts which commands a beat issues; what only a
 * real server can answer is whether those commands mean what we think - that
 * the expiry actually lands on the key, that the index score reads back as the
 * publish time, and that the prune removes what the TTL has already taken. All
 * three are the difference between a fleet view that self-heals and one that
 * accumulates rooms that ended.
 */
describe('Redis telemetry publisher', () => {
  let redis: TelemetryRedisClient;
  let publisher: RedisTelemetryPublisher;
  let eventBus: EventBusService;

  beforeAll(async () => {
    redis = await connectedClient();
    eventBus = new EventBusService(
      createMockLogger() as unknown as AppDependencies['logger'],
    );
    publisher = new RedisTelemetryPublisher(
      redis,
      {
        process: () => fakeProcess(),
        sessions: () => ({ sessions: [fakeSession()], truncated: false }),
      } as unknown as AppDependencies['statusSnapshotService'],
      { redisUrl: inject('redisUrl'), nodeInstanceId: NODE_INSTANCE_ID },
      createMockLogger() as unknown as AppDependencies['logger'],
      eventBus,
    );
    await redis.flushall();
    await publisher.publishOnce();
  });

  afterAll(async () => {
    await publisher.stop();
  });

  describe('one beat', (it) => {
    it('writes the instance record under an expiry, indexed by publish time', async () => {
      // Act
      const [record, ttl, score] = await Promise.all([
        redis.get(nodeSnapshotKey(NODE_INSTANCE_ID)),
        redis.pttl(nodeSnapshotKey(NODE_INSTANCE_ID)),
        redis.zscore(NODE_INDEX_KEY, NODE_INSTANCE_ID),
      ]);

      // Assert - expiry is the liveness signal: nothing deletes this key, so
      // an instance that stops beating stops existing.
      expect(JSON.parse(record ?? 'null')).toMatchObject({
        nodeInstanceId: NODE_INSTANCE_ID,
        processUid: PROCESS_UID,
        summary: { activeSessionCount: 1 },
      });
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(NODE_TTL_MS);
      expect(Number(score)).toBeGreaterThan(Date.now() - NODE_TTL_MS);
    });

    it('writes each session record and the route naming this instance', async () => {
      // Act
      const [record, route, ttl] = await Promise.all([
        redis.get(sessionSnapshotKey(SESSION_UID)),
        redis.get(sessionRouteKey(SESSION_UID)),
        redis.pttl(sessionSnapshotKey(SESSION_UID)),
      ]);

      // Assert
      expect(JSON.parse(record ?? 'null')).toMatchObject({
        ...fakeSession(),
        nodeInstanceId: NODE_INSTANCE_ID,
      });
      expect(route).toBe(NODE_INSTANCE_ID);
      expect(ttl).toBeGreaterThan(0);
      expect(await redis.zscore(SESSION_INDEX_KEY, SESSION_UID)).not.toBeNull();
    });
  });

  describe('index pruning', (it) => {
    it('drops members whose snapshots have already expired', async () => {
      // Arrange - a session that ended while its owner was away: its snapshot
      // key expired on its own, but sorted-set members carry no TTL, so
      // nothing but this prune ever removes the uid.
      const staleUid = '00000000-0000-0000-0000-0000000dead0';
      await redis.zadd(
        SESSION_INDEX_KEY,
        Date.now() - NODE_TTL_MS - 1000,
        staleUid,
      );

      // Act
      await publisher.publishOnce();

      // Assert
      expect(await redis.zscore(SESSION_INDEX_KEY, staleUid)).toBeNull();
      expect(await redis.zscore(SESSION_INDEX_KEY, SESSION_UID)).not.toBeNull();
    });
  });
});

/**
 * A separate publisher/connection pair, kept independent of the heartbeat
 * suite above: `start()` runs a live interval and subscribes to the
 * in-process event bus, which would otherwise interleave with the other
 * describe block's manual `publishOnce()` calls against the same keys.
 */
describe('Redis telemetry publisher — fleet event deltas', () => {
  let redis: TelemetryRedisClient;
  let subscriber: TelemetryRedisClient;
  let publisher: RedisTelemetryPublisher;
  let eventBus: EventBusService;

  beforeAll(async () => {
    redis = await connectedClient();
    subscriber = await connectedClient();
    eventBus = new EventBusService(
      createMockLogger() as unknown as AppDependencies['logger'],
    );
    publisher = new RedisTelemetryPublisher(
      redis,
      {
        process: () => fakeProcess(),
        sessions: () => ({ sessions: [], truncated: false }),
      } as unknown as AppDependencies['statusSnapshotService'],
      { redisUrl: inject('redisUrl'), nodeInstanceId: 'test-node-deltas' },
      createMockLogger() as unknown as AppDependencies['logger'],
      eventBus,
    );
    publisher.start();
  });

  afterAll(async () => {
    await publisher.stop();
    await subscriber.quit();
  });

  describe('delta forwarding', (it) => {
    it('round-trips a session status delta through real Redis pub/sub', async () => {
      // Arrange
      const received = new Promise<string>((resolve) => {
        subscriber.once('message', (_channel, message: string) => {
          resolve(message);
        });
      });
      await subscriber.subscribe(FLEET_EVENTS_CHANNEL_KEY);

      // Act
      eventBus.publish(FleetStatusDeltaChannel, {
        sessionUid: SESSION_UID,
        transcriptionServiceConnected: true,
        sourceDeviceConnected: true,
        at: Date.now(),
      });

      // Assert
      const message = await received;
      expect(JSON.parse(message)).toMatchObject({
        t: 'session',
        sessionUid: SESSION_UID,
        transcriptionServiceConnected: true,
        sourceDeviceConnected: true,
      });
    });
  });
});

describe('Node Server wired to the backplane', () => {
  let redis: TelemetryRedisClient;
  let fastify: Awaited<ReturnType<typeof createServer>>['fastify'];

  beforeAll(async () => {
    redis = await connectedClient();
    const config = buildTestAppConfig({
      telemetryPublisherConfig: {
        redisUrl: inject('redisUrl'),
        nodeInstanceId: WIRED_INSTANCE_ID,
      },
    });
    ({ fastify } = await createServer(config));
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    await redis.quit();
  });

  describe('boot', (it) => {
    it('publishes this instance without a session ever being opened', async () => {
      // Assert - an instance that is up and idle must be distinguishable from
      // one that has died, which a fleet view assembled from session records
      // alone cannot do. The first beat is immediate, so this needs no
      // heartbeat to have elapsed.
      await vi.waitFor(
        async () => {
          const record = await redis.get(nodeSnapshotKey(WIRED_INSTANCE_ID));
          expect(JSON.parse(record ?? 'null')).toMatchObject({
            nodeInstanceId: WIRED_INSTANCE_ID,
            summary: { activeSessionCount: 0 },
          });
        },
        { timeout: 10_000 },
      );
    });
  });
});
