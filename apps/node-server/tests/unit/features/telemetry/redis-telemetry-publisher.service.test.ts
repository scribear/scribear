import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import type {
  StatusProcess,
  StatusSession,
} from '@scribear/node-server-schema';
import {
  FLEET_EVENTS_CHANNEL_KEY,
  NODE_HEARTBEAT_MS,
  NODE_INDEX_KEY,
  NODE_TTL_MS,
  SESSION_INDEX_KEY,
  nodeSnapshotKey,
  sessionRouteKey,
  sessionSnapshotKey,
} from '@scribear/scribear-redis';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { RedisTelemetryPublisher } from '#src/server/features/telemetry/redis-telemetry-publisher.service.js';
import { FleetStatusDeltaChannel } from '#src/server/features/transcription-stream/events/fleet-status-delta.events.js';
import { EventBusService } from '#src/server/shared/services/event-bus.service.js';
import { type MockLogger, createMockLogger } from '#tests/utils/mock-logger.js';

const NODE_INSTANCE_ID = 'node-a7';
const PROCESS_UID = '00000000-0000-0000-0000-0000000000ff';
const SESSION_UID = '00000000-0000-0000-0000-000000000abc';
const ROOM_UID = '00000000-0000-0000-0000-000000000def';
const NOW = 1_800_000_000_000;

/** One command as issued against the pipeline, for readable assertions. */
type Command = [name: string, ...args: unknown[]];

/**
 * Stand-in for the ioredis client. Records the commands a beat queues and
 * lets a test decide how `exec` resolves, which is the only thing the
 * publisher's failure handling reacts to.
 */
class FakeRedis {
  commands: Command[] = [];
  execResult: [Error | null, unknown][] | null = [];
  execError: Error | null = null;
  /** Resolves the in-flight `exec` when set, so overlap can be exercised. */
  releaseExec: (() => void) | null = null;
  quit = vi.fn(() => Promise.resolve('OK'));
  publish = vi.fn(() => Promise.resolve(0));

  private _handlers = new Map<string, (arg?: unknown) => void>();
  on = vi.fn((event: string, handler: (arg?: unknown) => void) => {
    this._handlers.set(event, handler);
    return this;
  });

  /** Fires an event the publisher subscribed to, as ioredis would. */
  emit(event: string, arg?: unknown): void {
    this._handlers.get(event)?.(arg);
  }

  pipeline() {
    const record = (name: string) => {
      return (...args: unknown[]) => {
        this.commands.push([name, ...args]);
        return chain;
      };
    };
    const chain = {
      set: record('set'),
      zadd: record('zadd'),
      zremrangebyscore: record('zremrangebyscore'),
      exec: async () => {
        if (this.releaseExec !== null) {
          await new Promise<void>((resolve) => {
            this.releaseExec = resolve;
          });
        }
        if (this.execError !== null) throw this.execError;
        return this.execResult;
      },
    };
    return chain;
  }
}

function fakeProcess(): StatusProcess {
  return {
    processUid: PROCESS_UID,
    processStartedAt: new Date(NOW - 60_000).toISOString(),
    generatedAt: new Date(NOW).toISOString(),
    summary: {
      activeSessionCount: 1,
      decodeDropsTotal: 0,
      pendingChunkEvictionsTotal: 0,
      upstreamChurnTotal: 2,
      authSuccessTotal: 3,
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
    providerKey: 'whisper',
    sourceCount: 1,
    subscriberCount: 43,
    pendingChunkCount: 7,
    upstreamState: 'OPEN',
    upstreamRetryAttempt: 0,
    latency: [],
  };
}

interface Harness {
  publisher: RedisTelemetryPublisher;
  redis: FakeRedis;
  logger: MockLogger;
  sessions: StatusSession[];
  eventBus: EventBusService;
}

function buildHarness(): Harness {
  const redis = new FakeRedis();
  const logger = createMockLogger();
  const sessions = [fakeSession()];
  const snapshots = {
    process: () => fakeProcess(),
    sessions: () => ({ sessions, truncated: false }),
  } as unknown as AppDependencies['statusSnapshotService'];
  const eventBus = new EventBusService(
    logger as unknown as AppDependencies['logger'],
  );

  const publisher = new RedisTelemetryPublisher(
    redis as unknown as AppDependencies['telemetryRedisClient'],
    snapshots,
    { redisUrl: 'redis://redis:6379', nodeInstanceId: NODE_INSTANCE_ID },
    logger as unknown as AppDependencies['logger'],
    eventBus,
  );
  return { publisher, redis, logger, sessions, eventBus };
}

/** Finds the single command whose first argument is `key`. */
function commandFor(commands: Command[], key: string): Command | undefined {
  return commands.find(([, first]) => first === key);
}

describe('RedisTelemetryPublisher beat contents', (it) => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes this instance under a TTL and indexes it at the publish time', async () => {
    // Arrange
    const h = buildHarness();

    // Act
    await h.publisher.publishOnce();

    // Assert - the instance record is what distinguishes an instance that is
    // up and idle from one that has died; both contribute no sessions.
    const snapshot = commandFor(
      h.redis.commands,
      nodeSnapshotKey(NODE_INSTANCE_ID),
    );
    expect(snapshot?.[0]).toBe('set');
    expect(snapshot?.[3]).toBe('PX');
    expect(snapshot?.[4]).toBe(NODE_TTL_MS);
    expect(JSON.parse(String(snapshot?.[2]))).toMatchObject({
      nodeInstanceId: NODE_INSTANCE_ID,
      processUid: PROCESS_UID,
      updatedAt: NOW,
      summary: { activeSessionCount: 1 },
    });
    expect(h.redis.commands).toContainEqual([
      'zadd',
      NODE_INDEX_KEY,
      NOW,
      NODE_INSTANCE_ID,
    ]);
  });

  it('writes one record per live session, carrying the /status fields verbatim', async () => {
    // Arrange
    const h = buildHarness();

    // Act
    await h.publisher.publishOnce();

    // Assert - the session record is the `/status` session record plus who
    // published it and when, so a consumer that renders one renders the other.
    const record = commandFor(
      h.redis.commands,
      sessionSnapshotKey(SESSION_UID),
    );
    expect(JSON.parse(String(record?.[2]))).toStrictEqual({
      ...fakeSession(),
      nodeInstanceId: NODE_INSTANCE_ID,
      processUid: PROCESS_UID,
      updatedAt: NOW,
    });
    expect(record?.[4]).toBe(NODE_TTL_MS);
    expect(h.redis.commands).toContainEqual([
      'zadd',
      SESSION_INDEX_KEY,
      NOW,
      SESSION_UID,
    ]);
  });

  it('names this instance as the owner of each session it publishes', async () => {
    // Arrange
    const h = buildHarness();

    // Act
    await h.publisher.publishOnce();

    // Assert - a bare string, not JSON: it answers "who do I ask about this
    // room" and is read without parsing.
    expect(commandFor(h.redis.commands, sessionRouteKey(SESSION_UID))).toEqual([
      'set',
      sessionRouteKey(SESSION_UID),
      NODE_INSTANCE_ID,
      'PX',
      NODE_TTL_MS,
    ]);
  });

  it('prunes both indexes by score, since sorted-set members never expire', async () => {
    // Arrange
    const h = buildHarness();

    // Act
    await h.publisher.publishOnce();

    // Assert - without this the session index accumulates the uid of every
    // room the fleet has ever run, and a dead instance never leaves the node
    // index. Pruning is by score and so is not scoped to this instance.
    expect(h.redis.commands).toContainEqual([
      'zremrangebyscore',
      SESSION_INDEX_KEY,
      0,
      NOW - NODE_TTL_MS,
    ]);
    expect(h.redis.commands).toContainEqual([
      'zremrangebyscore',
      NODE_INDEX_KEY,
      0,
      NOW - NODE_TTL_MS,
    ]);
  });

  it('writes nothing per session when the instance is idle', async () => {
    // Arrange
    const h = buildHarness();
    h.sessions.length = 0;

    // Act
    await h.publisher.publishOnce();

    // Assert - only the instance record and the two prunes, so an idle
    // instance still reports itself as alive.
    expect(commandFor(h.redis.commands, sessionSnapshotKey(SESSION_UID))).toBe(
      undefined,
    );
    expect(
      commandFor(h.redis.commands, nodeSnapshotKey(NODE_INSTANCE_ID)),
    ).toBeDefined();
  });
});

describe('RedisTelemetryPublisher failure handling', (it) => {
  it('swallows a failed beat and logs it once until it recovers', async () => {
    // Arrange - Redis being unreachable must never reach a caller: nothing in
    // the transcription path awaits a beat, and an outage lasting minutes must
    // not produce a warning every two seconds.
    const h = buildHarness();
    h.redis.execError = new Error('connection is closed');

    // Act
    await h.publisher.publishOnce();
    await h.publisher.publishOnce();

    // Assert
    expect(h.logger.warn).toHaveBeenCalledTimes(1);

    // Act - recovery re-arms the warning and says so.
    h.redis.execError = null;
    await h.publisher.publishOnce();
    h.redis.execError = new Error('connection is closed');
    await h.publisher.publishOnce();

    // Assert
    expect(h.logger.info).toHaveBeenCalledWith(
      'telemetry publishing recovered',
    );
    expect(h.logger.warn).toHaveBeenCalledTimes(2);
  });

  it('treats a per-command failure as a failed beat', async () => {
    // Arrange - `exec` resolves rather than rejecting when individual commands
    // fail, so a partial write is only visible in the replies.
    const h = buildHarness();
    h.redis.execResult = [
      [null, 'OK'],
      [new Error('OOM command not allowed'), null],
    ];

    // Act
    await h.publisher.publishOnce();

    // Assert
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });

  it('skips a beat that would overlap one still in flight', async () => {
    // Arrange - a beat slower than the interval must not queue: the next one
    // rewrites the same keys, so queueing publishes a backlog of stale
    // snapshots.
    const h = buildHarness();
    h.redis.releaseExec = () => {
      // Replaced by `exec` with the resolver for the in-flight call.
    };
    const first = h.publisher.publishOnce();
    const commandsAfterFirst = h.redis.commands.length;

    // Act
    await h.publisher.publishOnce();

    // Assert
    expect(h.redis.commands.length).toBe(commandsAfterFirst);

    // Cleanup - let the first beat finish. `exec` always reassigns
    // `releaseExec` to the in-flight resolver, so it is non-null here.
    h.redis.releaseExec();
    await first;
  });
});

describe('RedisTelemetryPublisher lifecycle', (it) => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('beats on connect and then every heartbeat until stopped', async () => {
    // Arrange
    const h = buildHarness();

    // Act - the connection is established asynchronously and the client
    // refuses to queue commands while it is not, so the first beat waits for
    // `ready` rather than failing against a connection still being made.
    h.publisher.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.redis.commands).toStrictEqual([]);

    h.redis.emit('ready');
    await vi.advanceTimersByTimeAsync(0);
    const afterStart = h.redis.commands.length;
    await vi.advanceTimersByTimeAsync(NODE_HEARTBEAT_MS);

    // Assert
    expect(afterStart).toBeGreaterThan(0);
    expect(h.redis.commands.length).toBe(afterStart * 2);

    // Act - and stops beating, leaving its keys to expire on their own.
    await h.publisher.stop();
    await vi.advanceTimersByTimeAsync(NODE_HEARTBEAT_MS * 3);

    // Assert
    expect(h.redis.commands.length).toBe(afterStart * 2);
    expect(h.redis.quit).toHaveBeenCalledTimes(1);
  });

  it('attaches an error listener, without which ioredis would kill the process', async () => {
    // Arrange
    const h = buildHarness();

    // Act
    h.publisher.start();
    await vi.advanceTimersByTimeAsync(0);

    // Assert
    expect(h.redis.on).toHaveBeenCalledWith('error', expect.any(Function));
    // An error is logged at debug, not warn: the client emits one per retry
    // attempt for as long as an outage lasts, and the beat already reports it.
    h.redis.emit('error', new Error('ECONNREFUSED'));
    expect(h.logger.debug).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).not.toHaveBeenCalled();

    // Cleanup
    await h.publisher.stop();
  });

  it('re-publishes on every reconnect, restoring this instance immediately', async () => {
    // Arrange - keys expire while the connection is down, so an instance that
    // waited for its next scheduled beat would be missing from the fleet view
    // for up to a heartbeat after it was reachable again.
    const h = buildHarness();
    h.publisher.start();
    h.redis.emit('ready');
    await vi.advanceTimersByTimeAsync(0);
    const afterConnect = h.redis.commands.length;

    // Act
    h.redis.emit('ready');
    await vi.advanceTimersByTimeAsync(0);

    // Assert
    expect(h.redis.commands.length).toBe(afterConnect * 2);

    // Cleanup
    await h.publisher.stop();
  });

  it('forwards a session status delta to the fleet events channel once started', async () => {
    // Arrange
    const h = buildHarness();
    h.publisher.start();

    // Act
    h.eventBus.publish(FleetStatusDeltaChannel, {
      sessionUid: SESSION_UID,
      transcriptionServiceConnected: true,
      sourceDeviceConnected: false,
      at: NOW,
    });
    await vi.advanceTimersByTimeAsync(0);

    // Assert
    expect(h.redis.publish).toHaveBeenCalledWith(
      FLEET_EVENTS_CHANNEL_KEY,
      JSON.stringify({
        t: 'session',
        sessionUid: SESSION_UID,
        transcriptionServiceConnected: true,
        sourceDeviceConnected: false,
        at: NOW,
      }),
    );

    // Cleanup
    await h.publisher.stop();
  });

  it('stops forwarding deltas once stopped', async () => {
    // Arrange
    const h = buildHarness();
    h.publisher.start();
    await h.publisher.stop();

    // Act
    h.eventBus.publish(FleetStatusDeltaChannel, {
      sessionUid: SESSION_UID,
      transcriptionServiceConnected: true,
      sourceDeviceConnected: false,
      at: NOW,
    });
    await vi.advanceTimersByTimeAsync(0);

    // Assert
    expect(h.redis.publish).not.toHaveBeenCalled();
  });

  it('never touches Redis for a delta published before start() is called', async () => {
    // A telemetry-disabled instance never calls start() at all (create-server
    // only resolves this class behind the REDIS_URL check), so the
    // orchestrator's publish must be a no-op with nothing listening.
    //
    // Arrange
    const h = buildHarness();

    // Act
    h.eventBus.publish(FleetStatusDeltaChannel, {
      sessionUid: SESSION_UID,
      transcriptionServiceConnected: true,
      sourceDeviceConnected: false,
      at: NOW,
    });
    await vi.advanceTimersByTimeAsync(0);

    // Assert
    expect(h.redis.publish).not.toHaveBeenCalled();
  });
});
