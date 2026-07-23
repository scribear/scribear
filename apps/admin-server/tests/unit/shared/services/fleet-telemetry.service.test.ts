import { beforeEach, describe, expect, vi } from 'vitest';

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
  nodeSnapshotKey,
  sessionSnapshotKey,
  transcriptionHostSnapshotKey,
} from '@scribear/scribear-redis';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { FleetTelemetryService } from '#src/server/shared/services/fleet-telemetry.service.js';
import { type MockLogger, createMockLogger } from '#tests/utils/mock-logger.js';

const NOW = 1_800_000_000_000;

/**
 * Stand-in for the ioredis client. `snapshot()` only issues `zrangebyscore`
 * and `mget`, so that is all this needs to fake.
 */
class FakeRedis {
  zsets = new Map<string, string[]>();
  values = new Map<string, string>();
  quit = vi.fn(() => Promise.resolve('OK'));

  private _handlers = new Map<string, (arg?: unknown) => void>();
  on = vi.fn((event: string, handler: (arg?: unknown) => void) => {
    this._handlers.set(event, handler);
    return this;
  });

  emit(event: string, arg?: unknown): void {
    this._handlers.get(event)?.(arg);
  }

  zrangebyscore = vi.fn((key: string) =>
    Promise.resolve(this.zsets.get(key) ?? []),
  );

  mget = vi.fn((keys: string[]) =>
    Promise.resolve(keys.map((k) => this.values.get(k) ?? null)),
  );

  set(key: string, value: unknown, indexKey: string, member: string): void {
    this.values.set(key, JSON.stringify(value));
    this.zsets.set(indexKey, [...(this.zsets.get(indexKey) ?? []), member]);
  }
}

function fakeProviderHealth(
  overrides: Partial<ProviderHealth> = {},
): ProviderHealth {
  return {
    providerUid: 'whisper-local',
    kind: 'local',
    status: 'ok',
    activeSessions: 0,
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

function fakeHostSnapshot(
  transcriptionHost: string,
  providers: Record<string, ProviderHealth>,
): TranscriptionHostSnapshot {
  return {
    updatedAt: NOW,
    transcriptionHost,
    processUid: '00000000-0000-0000-0000-0000000000ff',
    processStartedAt: new Date(NOW - 60_000).toISOString(),
    numWorkers: 1,
    invalidProviderKeyRejects: 0,
    workers: [],
    providers,
  };
}

interface Harness {
  service: FleetTelemetryService;
  redis: FakeRedis;
  logger: MockLogger;
}

function buildHarness(): Harness {
  const redis = new FakeRedis();
  const logger = createMockLogger();
  const service = new FleetTelemetryService(
    redis as unknown as TelemetryRedisClient,
    logger as unknown as AppDependencies['logger'],
  );
  return { service, redis, logger };
}

describe('FleetTelemetryService', () => {
  describe('enabled', (it) => {
    it('is disabled when no client was built (REDIS_URL unset)', () => {
      const service = new FleetTelemetryService(
        null,
        createMockLogger() as unknown as AppDependencies['logger'],
      );

      expect(service.enabled).toBe(false);
    });

    it('is enabled when a client was built', () => {
      const h = buildHarness();

      expect(h.service.enabled).toBe(true);
    });

    it('attaches an error listener, without which ioredis would kill the process', () => {
      const h = buildHarness();

      expect(h.redis.on).toHaveBeenCalledWith('error', expect.any(Function));
      h.redis.emit('error', new Error('ECONNREFUSED'));
      expect(h.logger.debug).toHaveBeenCalledTimes(1);
    });
  });

  describe('snapshot', (it) => {
    let h: Harness;

    beforeEach(() => {
      h = buildHarness();
    });

    it('returns everything empty when no index has live members', async () => {
      const snap = await h.service.snapshot();

      expect(snap.nodes).toEqual([]);
      expect(snap.sessions).toEqual([]);
      expect(snap.transcriptionHosts).toEqual([]);
      expect(snap.providers).toEqual([]);
    });

    it('reads live nodes, sessions and hosts from their indexes', async () => {
      const node: NodeSnapshot = {
        updatedAt: NOW,
        nodeInstanceId: 'node-a',
        processUid: '00000000-0000-0000-0000-000000000001',
        processStartedAt: new Date(NOW - 1000).toISOString(),
        generatedAt: new Date(NOW).toISOString(),
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
      h.redis.set(nodeSnapshotKey('node-a'), node, NODE_INDEX_KEY, 'node-a');

      const session: SessionSnapshot = {
        sessionUid: '00000000-0000-0000-0000-0000000000ab',
        providerKey: 'whisper',
        sourceCount: 1,
        subscriberCount: 1,
        pendingChunkCount: 0,
        upstreamState: 'OPEN',
        upstreamRetryAttempt: 0,
        latency: [],
        updatedAt: NOW,
        nodeInstanceId: 'node-a',
        processUid: '00000000-0000-0000-0000-000000000001',
      };
      h.redis.set(
        sessionSnapshotKey(session.sessionUid),
        session,
        SESSION_INDEX_KEY,
        session.sessionUid,
      );

      const host = fakeHostSnapshot('ts-a', {
        whisper: fakeProviderHealth({ activeSessions: 1 }),
      });
      h.redis.set(
        transcriptionHostSnapshotKey('ts-a'),
        host,
        TRANSCRIPTION_HOST_INDEX_KEY,
        'ts-a',
      );

      const snap = await h.service.snapshot();

      expect(snap.nodes).toEqual([node]);
      expect(snap.sessions).toEqual([session]);
      expect(snap.transcriptionHosts).toEqual([host]);
    });

    it('drops an indexed member whose snapshot key already expired', async () => {
      // The index and the key it names have independent TTLs (sorted-set
      // members never expire on their own) — a member can outlive its value
      // between the two reads.
      h.redis.zsets.set(NODE_INDEX_KEY, ['ghost-node']);

      const snap = await h.service.snapshot();

      expect(snap.nodes).toEqual([]);
    });
  });

  describe('provider merge', (it) => {
    let h: Harness;

    beforeEach(() => {
      h = buildHarness();
    });

    function withHosts(
      ...hosts: [string, Record<string, ProviderHealth>][]
    ): void {
      for (const [name, providers] of hosts) {
        h.redis.set(
          transcriptionHostSnapshotKey(name),
          fakeHostSnapshot(name, providers),
          TRANSCRIPTION_HOST_INDEX_KEY,
          name,
        );
      }
    }

    it('sums activeSessions for the same providerKey across hosts', async () => {
      withHosts(
        ['ts-a', { whisper: fakeProviderHealth({ activeSessions: 2 }) }],
        ['ts-b', { whisper: fakeProviderHealth({ activeSessions: 3 }) }],
      );

      const snap = await h.service.snapshot();

      expect(snap.providers).toHaveLength(1);
      expect(snap.providers[0]).toMatchObject({
        providerKey: 'whisper',
        activeSessions: 5,
      });
      expect(
        snap.providers[0]?.hosts.map((entry) => entry.transcriptionHost),
      ).toEqual(['ts-a', 'ts-b']);
    });

    it('reports ok when at least one host is fully ok, not the worst status', async () => {
      // A provider down on one host still has capacity via the other — that
      // is a degraded picture, not the worst-of-both-hosts "down".
      withHosts(
        ['ts-a', { whisper: fakeProviderHealth({ status: 'down' }) }],
        ['ts-b', { whisper: fakeProviderHealth({ status: 'ok' }) }],
      );

      const snap = await h.service.snapshot();

      expect(snap.providers[0]?.status).toBe('ok');
    });

    it('reports down only when every host serving the key is down', async () => {
      withHosts(
        ['ts-a', { whisper: fakeProviderHealth({ status: 'down' }) }],
        ['ts-b', { whisper: fakeProviderHealth({ status: 'down' }) }],
      );

      const snap = await h.service.snapshot();

      expect(snap.providers[0]?.status).toBe('down');
    });

    it('keeps distinct providerKeys as separate cards', async () => {
      withHosts([
        'ts-a',
        {
          whisper: fakeProviderHealth(),
          'lumen-granite': fakeProviderHealth({ kind: 'remote' }),
        },
      ]);

      const snap = await h.service.snapshot();

      expect(snap.providers.map((p) => p.providerKey).sort()).toEqual([
        'lumen-granite',
        'whisper',
      ]);
    });
  });

  describe('when disabled', (it) => {
    it('rejects snapshot() rather than opening a connection', async () => {
      const service = new FleetTelemetryService(
        null,
        createMockLogger() as unknown as AppDependencies['logger'],
      );

      await expect(service.snapshot()).rejects.toThrow(/disabled/);
    });
  });
});
