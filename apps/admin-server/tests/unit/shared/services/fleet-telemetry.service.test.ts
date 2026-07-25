import { beforeEach, describe, expect, vi } from 'vitest';

import type {
  AudioStage,
  NodeSnapshot,
  ProviderHealth,
  SessionAudioSnapshot,
  SessionSnapshot,
  TelemetryRedisClient,
  TranscriptionHostSnapshot,
  VadStats,
} from '@scribear/scribear-redis';
import {
  NODE_INDEX_KEY,
  SESSION_INDEX_KEY,
  TRANSCRIPTION_HOST_INDEX_KEY,
  TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
  nodeSnapshotKey,
  sessionSnapshotKey,
  transcriptionHostSnapshotKey,
  transcriptionSessionAudioKey,
} from '@scribear/scribear-redis';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import {
  FleetTelemetryService,
  VALIDATION_DROP_LOG_INTERVAL_MS,
} from '#src/server/shared/services/fleet-telemetry.service.js';
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

  ping = vi.fn(() => Promise.resolve('PONG'));

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

const FAKE_VAD_STATS: VadStats = {
  vadEnabled: true,
  speechActiveRatio: 0.42,
  segmentCount: 3,
  meanSegmentDurationSec: 1.2,
  speechToPauseRatio: 0.72,
  snrDb: 18.5,
};

/** The `ingress` point every provider reports: metered, no detector. */
function fakeAudioStage(overrides: Partial<AudioStage> = {}): AudioStage {
  return {
    stage: 'ingress',
    label: 'Source ingress',
    depth: 1,
    inputs: [],
    levels: {
      rmsDbfs: -23.4,
      peakDbfs: -12.1,
      clippingPct: 0,
      silence: false,
      noiseFloorDbfs: -65.0,
    },
    vad: null,
    audioSeconds: 123.4,
    ...overrides,
  };
}

function fakeAudioSnapshot(
  sessionUid: string,
  overrides: Partial<SessionAudioSnapshot> = {},
): SessionAudioSnapshot {
  return {
    updatedAt: NOW,
    stages: [fakeAudioStage()],
    sessionUid,
    roomUid: null,
    transcriptionHost: 'ts-a',
    ...overrides,
  };
}

/** A node-instance record exactly as `RedisTelemetryPublisher` writes one. */
function fakeNodeSnapshot(nodeInstanceId: string): NodeSnapshot {
  return {
    updatedAt: NOW,
    nodeInstanceId,
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
}

/**
 * A session record as published. `sessionUid` must be a uuid: the schema
 * declares `format: 'uuid'`, typebox enforces it, and this index drops what
 * fails validation.
 */
function fakeSessionSnapshot(sessionUid: string): SessionSnapshot {
  return {
    sessionUid,
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
      expect(snap.sessionAudio).toEqual([]);
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

    it('reads live audio snapshots from the transcription-session-audio index', async () => {
      // Arrange
      const audio = fakeAudioSnapshot('session-a');
      h.redis.set(
        transcriptionSessionAudioKey('session-a'),
        audio,
        TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
        'session-a',
      );

      // Act
      const snap = await h.service.snapshot();

      // Assert
      expect(snap.sessionAudio).toEqual([audio]);
    });

    it('keeps the whole stage graph, depth and inputs included', async () => {
      // Arrange — the three points the shipped providers report. `depth` and
      // `inputs` are what let the webapp lay the pipeline out in columns with
      // edges and compare `audioSeconds` across one edge, so a reader that
      // silently dropped them would leave the "where did the audio stop being
      // good" question unanswerable (§12.2).
      const audio = fakeAudioSnapshot('session-graph', {
        stages: [
          fakeAudioStage(),
          fakeAudioStage({
            stage: 'asr_input',
            label: 'ASR input (worker decode)',
            depth: 2,
            inputs: ['ingress'],
            audioSeconds: 122.9,
          }),
          fakeAudioStage({
            stage: 'vad',
            label: 'VAD (Silero)',
            depth: 3,
            inputs: ['asr_input'],
            levels: null,
            vad: FAKE_VAD_STATS,
            audioSeconds: 47.2,
          }),
        ],
      });
      h.redis.set(
        transcriptionSessionAudioKey('session-graph'),
        audio,
        TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
        'session-graph',
      );

      // Act
      const snap = await h.service.snapshot();

      // Assert
      expect(snap.sessionAudio).toEqual([audio]);
      expect(snap.sessionAudio[0]?.stages.map((s) => s.depth)).toEqual([
        1, 2, 3,
      ]);
      expect(snap.sessionAudio[0]?.stages.map((s) => s.inputs)).toEqual([
        [],
        ['ingress'],
        ['asr_input'],
      ]);
    });

    it('reads a stage whose vad is null (a point that runs no detector)', async () => {
      // Arrange — "no detector here" and "detector present but configured off"
      // (`vad.vadEnabled: false`) are different states and must not collapse,
      // so `vad: null` has to survive the read rather than be normalised away.
      const audio = fakeAudioSnapshot('session-b', {
        stages: [fakeAudioStage({ vad: null })],
      });
      h.redis.set(
        transcriptionSessionAudioKey('session-b'),
        audio,
        TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
        'session-b',
      );

      // Act
      const snap = await h.service.snapshot();

      // Assert
      expect(snap.sessionAudio).toEqual([audio]);
      expect(snap.sessionAudio[0]?.stages[0]?.vad).toBeNull();
    });

    it('returns audio present even when no matching session exists (D2: no join)', async () => {
      // Audio present, session absent — the two publishers do not coordinate.
      // The audio index is a distinct index from the session index; the reader
      // returns audio flat without joining, so this asymmetry is preserved.
      const audio = fakeAudioSnapshot('orphan-session');
      h.redis.set(
        transcriptionSessionAudioKey('orphan-session'),
        audio,
        TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
        'orphan-session',
      );

      const snap = await h.service.snapshot();

      expect(snap.sessions).toEqual([]);
      expect(snap.sessionAudio).toEqual([audio]);
    });

    it('returns sessions present even when no audio snapshot exists', async () => {
      // Session present, audio absent — nothing has decoded audio for this
      // session in >=10s. This is failure mode C1 and is itself a finding.
      //
      // The uid is a uuid rather than the descriptive 'no-audio-session' it
      // used to be: `sessionUid` declares `format: 'uuid'`, typebox enforces
      // it, and this index now hard-drops what fails validation. The readable
      // string only ever passed because nothing checked — which is the whole
      // reason the promotion was worth doing.
      const session: SessionSnapshot = {
        sessionUid: '00000000-0000-0000-0000-00000000ffff',
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

      const snap = await h.service.snapshot();

      expect(snap.sessions).toEqual([session]);
      expect(snap.sessionAudio).toEqual([]);
    });

    it('drops an audio index member whose snapshot key has expired', async () => {
      // Same hole-dropping path as the other indexes: a member in the audio
      // index whose key has expired between the ZRANGEBYSCORE and the MGET.
      h.redis.zsets.set(TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY, ['ghost-audio']);

      const snap = await h.service.snapshot();

      expect(snap.sessionAudio).toEqual([]);
      // An expiry is routine and must stay quiet, unlike a validation drop.
      expect(h.logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('snapshot validation', (it) => {
    let h: Harness;

    /** Puts a raw, un-stringified value under a key the audio index names. */
    function setRawAudio(member: string, raw: string): void {
      h.redis.values.set(transcriptionSessionAudioKey(member), raw);
      h.redis.zsets.set(TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY, [
        ...(h.redis.zsets.get(TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY) ?? []),
        member,
      ]);
    }

    /** The flat pre-§12.4 payload, verbatim: one measurement point, no graph. */
    function legacyFlatAudioSnapshot(sessionUid: string): unknown {
      return {
        rmsDbfs: -21.3,
        peakDbfs: -9.8,
        clippingPct: 0,
        silence: false,
        noiseFloorDbfs: -62.0,
        updatedAt: NOW,
        vadStats: null,
        sessionUid,
        roomUid: null,
        transcriptionHost: 'ts-a',
      };
    }

    beforeEach(() => {
      h = buildHarness();
    });

    it('drops an audio snapshot still in the old flat shape instead of surfacing undefined fields', async () => {
      // Arrange — a publisher that has not been rolled forward yet. Cast
      // rather than validated, this parses happily and every stage-shaped
      // field reads `undefined` in the dashboard; §12.4 ships no compatibility
      // shim precisely because the reader rejects it outright.
      h.redis.set(
        transcriptionSessionAudioKey('legacy-session'),
        legacyFlatAudioSnapshot('legacy-session'),
        TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
        'legacy-session',
      );

      // Act
      const snap = await h.service.snapshot();

      // Assert
      expect(snap.sessionAudio).toEqual([]);
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          indexKey: TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
          droppedCount: 1,
          droppedSample: [
            expect.objectContaining({
              member: 'legacy-session',
              reason: 'schema-mismatch',
              errors: expect.arrayContaining([expect.any(String)]),
            }),
          ],
        }),
        expect.any(String),
      );
    });

    it('drops one invalid audio snapshot without costing the others', async () => {
      // Arrange — the reason a drop is a drop and not a throw: an operator
      // must not lose the whole fleet's telemetry to one bad session.
      const healthy = fakeAudioSnapshot('healthy-session');
      h.redis.set(
        transcriptionSessionAudioKey('healthy-session'),
        healthy,
        TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
        'healthy-session',
      );
      h.redis.set(
        transcriptionSessionAudioKey('legacy-session'),
        legacyFlatAudioSnapshot('legacy-session'),
        TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
        'legacy-session',
      );

      // Act
      const snap = await h.service.snapshot();

      // Assert
      expect(snap.sessionAudio).toEqual([healthy]);
    });

    it('drops a malformed-JSON audio value rather than failing the whole call', async () => {
      // Arrange — a truncated write, or a key collision with a non-telemetry
      // producer. `JSON.parse` throws on it, and unhandled that throw used to
      // reach the controller as a 503 for every caller.
      setRawAudio('truncated-session', '{"stages":[{"stage":"ing');

      // Act
      const snap = await h.service.snapshot();

      // Assert
      expect(snap.sessionAudio).toEqual([]);
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          droppedSample: [
            expect.objectContaining({
              member: 'truncated-session',
              reason: 'malformed-json',
            }),
          ],
        }),
        expect.any(String),
      );
    });

    it('drops a drifted node snapshot rather than serving it unvalidated', async () => {
      // Arrange — these three indexes spent a release validating in log-only
      // mode, returning the payload anyway, because their schemas had never
      // been checked against their publishers. They are pinned now
      // (node-server's `publisher-schema-crosscheck.test.ts` and
      // `tools/telemetry-snapshot-crosscheck/`), so a mismatch here means a
      // genuinely drifted publisher and must not reach the dashboard as a
      // half-`undefined` card.
      h.redis.set(
        nodeSnapshotKey('drifted-node'),
        { ...fakeNodeSnapshot('drifted-node'), summary: 'not an object' },
        NODE_INDEX_KEY,
        'drifted-node',
      );

      // Act
      const snap = await h.service.snapshot();

      // Assert
      expect(snap.nodes).toEqual([]);
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          indexKey: NODE_INDEX_KEY,
          droppedSample: [
            expect.objectContaining({
              member: 'drifted-node',
              reason: 'schema-mismatch',
            }),
          ],
        }),
        expect.any(String),
      );
    });

    it('drops a drifted session snapshot rather than serving it unvalidated', async () => {
      // Arrange — `upstreamState` is a closed union, and a value outside it
      // would reach `deriveSessionStatus` as an unhandled case.
      h.redis.set(
        sessionSnapshotKey('00000000-0000-0000-0000-00000000dead'),
        {
          ...fakeSessionSnapshot('00000000-0000-0000-0000-00000000dead'),
          upstreamState: 'RETICULATING',
        },
        SESSION_INDEX_KEY,
        '00000000-0000-0000-0000-00000000dead',
      );

      // Act
      const snap = await h.service.snapshot();

      // Assert
      expect(snap.sessions).toEqual([]);
    });

    it('drops a drifted host snapshot, and the providers derived from it', async () => {
      // Arrange — the reason this promotion was taken last and needed a
      // cross-check against the Python publisher first: `mergeProviders`
      // derives entirely from `transcriptionHosts`, so dropping a host blanks
      // the providers section as well. That is correct once the schema is
      // pinned and would have been an outage before it was.
      const host = fakeHostSnapshot('ts-drifted', {
        whisper: fakeProviderHealth({ activeSessions: 1 }),
      });
      h.redis.set(
        transcriptionHostSnapshotKey('ts-drifted'),
        {
          ...host,
          workers: [{ workerId: 'zero', contextIds: ['faster-whisper'] }],
        },
        TRANSCRIPTION_HOST_INDEX_KEY,
        'ts-drifted',
      );

      // Act
      const snap = await h.service.snapshot();

      // Assert
      expect(snap.transcriptionHosts).toEqual([]);
      expect(snap.providers).toEqual([]);
    });

    it('drops a malformed-JSON value from the node index too', async () => {
      // Arrange — every index validates now, but the JSON guard sits ahead of
      // the schema and must hold on its own: an unparseable value has no
      // shape to check and still must not throw out of the read.
      h.redis.values.set(nodeSnapshotKey('broken-node'), 'not json at all');
      h.redis.zsets.set(NODE_INDEX_KEY, ['broken-node']);

      // Act
      const snap = await h.service.snapshot();

      // Assert
      expect(snap.nodes).toEqual([]);
      expect(h.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          indexKey: NODE_INDEX_KEY,
          droppedSample: [
            expect.objectContaining({
              member: 'broken-node',
              reason: 'malformed-json',
            }),
          ],
        }),
        expect.any(String),
      );
    });

    it('logs a persistent shape drift once, not once per poll', async () => {
      // Arrange — a drifted publisher keeps writing the same wrong shape, and
      // `/fleet` is polled every few seconds by every open dashboard, so a
      // line per drop per poll would bury the line that explains the drift.
      h.redis.set(
        transcriptionSessionAudioKey('legacy-session'),
        legacyFlatAudioSnapshot('legacy-session'),
        TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
        'legacy-session',
      );

      // Act
      await h.service.snapshot();
      const second = await h.service.snapshot();

      // Assert — throttled, but still dropped: the data is not served just
      // because the complaint about it was suppressed.
      expect(h.logger.warn).toHaveBeenCalledTimes(1);
      expect(second.sessionAudio).toEqual([]);
    });

    it('reports how many drops the throttle swallowed when it logs again', async () => {
      // Arrange — without the count, the one line an operator sees understates
      // a fleet-wide drift as a single bad session.
      vi.useFakeTimers();
      h.redis.set(
        transcriptionSessionAudioKey('legacy-session'),
        legacyFlatAudioSnapshot('legacy-session'),
        TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
        'legacy-session',
      );

      // Act
      await h.service.snapshot();
      await h.service.snapshot();
      vi.advanceTimersByTime(VALIDATION_DROP_LOG_INTERVAL_MS + 1);
      await h.service.snapshot();

      // Assert
      expect(h.logger.warn).toHaveBeenCalledTimes(2);
      expect(h.logger.warn).toHaveBeenLastCalledWith(
        expect.objectContaining({ suppressedSinceLastLog: 1 }),
        expect.any(String),
      );
      vi.useRealTimers();
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

    it('rejects ping() rather than opening a connection', async () => {
      const service = new FleetTelemetryService(
        null,
        createMockLogger() as unknown as AppDependencies['logger'],
      );

      await expect(service.ping()).rejects.toThrow(/disabled/);
    });
  });

  describe('ping', (it) => {
    it('issues a raw PING on the same connection and returns the elapsed ms', async () => {
      const h = buildHarness();

      const latencyMs = await h.service.ping();

      expect(h.redis.ping).toHaveBeenCalledTimes(1);
      expect(latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('propagates a rejected PING rather than swallowing it', async () => {
      const h = buildHarness();
      h.redis.ping.mockRejectedValue(new Error('connection closed'));

      await expect(h.service.ping()).rejects.toThrow('connection closed');
    });
  });
});
