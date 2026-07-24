import {
  NODE_INDEX_KEY,
  NODE_TTL_MS,
  type NodeSnapshot,
  type ProviderHealth,
  SESSION_INDEX_KEY,
  type SessionSnapshot,
  TRANSCRIPTION_HOST_INDEX_KEY,
  TRANSCRIPTION_HOST_TTL_MS,
  type TelemetryRedisClient,
  type TranscriptionHostSnapshot,
  nodeSnapshotKey,
  sessionSnapshotKey,
  transcriptionHostSnapshotKey,
} from '@scribear/scribear-redis';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

export interface FleetTelemetryConfig {
  redisUrl: string;
}

/** One provider merged across every Transcription Service host serving it. */
export interface MergedProvider {
  providerKey: string;
  /**
   * `down` only when every host reporting this key is `down` — a single
   * host's `down` is a capacity loss, not an outage (matches the ranking the
   * `TRANSCRIPTION_HOST_SNAPSHOT_SCHEMA` doc comment specifies). `ok` only
   * when every host is `ok`.
   */
  status: 'ok' | 'degraded' | 'down';
  /** Summed across every host reporting this key. */
  activeSessions: number;
  /** Per-host detail, verbatim from each host's `/providers/health` body. */
  hosts: { transcriptionHost: string; health: ProviderHealth }[];
}

export interface FleetSnapshot {
  generatedAt: number;
  nodes: NodeSnapshot[];
  sessions: SessionSnapshot[];
  transcriptionHosts: TranscriptionHostSnapshot[];
  providers: MergedProvider[];
}

/**
 * Reads the fleet telemetry backplane (B1.7 §2.5) for the admin `/fleet`
 * endpoint: every live Node Server instance and session, every live
 * Transcription Service host, and providers merged across the hosts serving
 * them. Read-only counterpart to `RedisTelemetryPublisher` (node-server) and
 * its transcription-service equivalent — this is the first consumer of what
 * they publish.
 *
 * **No fan-out.** Every field here comes from Redis; this service never calls
 * a node-server or transcription-service instance directly, which is what
 * keeps the endpoint's cost independent of fleet size.
 *
 * Takes the connection pre-built rather than a `redisUrl`, matching
 * `RedisTelemetryPublisher` on node-server: the factory in
 * `register-dependencies.ts` is where `REDIS_URL` unset becomes "build no
 * client at all," so this class never has to decide whether to open one.
 *
 * The client is a plain constructor argument, not an Awilix-resolved
 * `AppDependencies` member: `resolveHandler`'s generic bound assumes every
 * named dependency is a non-nullable object (every other entry is a
 * controller, service, or config value), and a `TelemetryRedisClient | null`
 * member breaks that assumption for every route, not just this one.
 */
export class FleetTelemetryService {
  private _redis: TelemetryRedisClient | null;
  private _logger: AppDependencies['logger'];

  /** False when `REDIS_URL` is unset — no connection was ever opened. */
  readonly enabled: boolean;

  constructor(
    fleetTelemetryRedisClient: TelemetryRedisClient | null,
    logger: AppDependencies['logger'],
  ) {
    this._redis = fleetTelemetryRedisClient;
    this._logger = logger;
    this.enabled = fleetTelemetryRedisClient !== null;

    // An ioredis client with no `error` listener treats a connection failure
    // as unhandled and takes the process down with it — exactly backwards for
    // a read path whose failure should cost a caller one 503.
    this._redis?.on('error', (err) => {
      this._logger.debug({ err }, 'fleet telemetry redis connection error');
    });
  }

  async close(): Promise<void> {
    await this._redis?.quit().catch(() => {
      // Already disconnected, or never connected.
    });
  }

  /**
   * Round-trip latency of a raw `PING` on the same connection `snapshot()`
   * uses — no second client is opened. Used by `HealthCheckerService` for the
   * top-bar rollup's `redis` component.
   *
   * The connection is built with `enableOfflineQueue: false` and
   * `maxRetriesPerRequest: 0` (see `createTelemetryRedisClient`), so a fully
   * disconnected `PING` rejects immediately; a connected-but-hung Redis can
   * still stall, which is why the caller applies its own timeout race rather
   * than relying on this method to bound its own latency.
   */
  async ping(): Promise<number> {
    if (this._redis === null) {
      throw new Error('fleet telemetry is disabled: REDIS_URL is unset');
    }
    const start = Date.now();
    await this._redis.ping();
    return Date.now() - start;
  }

  async snapshot(): Promise<FleetSnapshot> {
    if (this._redis === null) {
      throw new Error('fleet telemetry is disabled: REDIS_URL is unset');
    }
    const redis = this._redis;
    const now = Date.now();

    const [nodes, sessions, transcriptionHosts] = await Promise.all([
      readIndexed<NodeSnapshot>(
        redis,
        NODE_INDEX_KEY,
        now - NODE_TTL_MS,
        nodeSnapshotKey,
      ),
      readIndexed<SessionSnapshot>(
        redis,
        SESSION_INDEX_KEY,
        now - NODE_TTL_MS,
        sessionSnapshotKey,
      ),
      readIndexed<TranscriptionHostSnapshot>(
        redis,
        TRANSCRIPTION_HOST_INDEX_KEY,
        now - TRANSCRIPTION_HOST_TTL_MS,
        transcriptionHostSnapshotKey,
      ),
    ]);

    return {
      generatedAt: now,
      nodes,
      sessions,
      transcriptionHosts,
      providers: mergeProviders(transcriptionHosts),
    };
  }
}

/**
 * `ZRANGEBYSCORE <indexKey> <minScore> +inf` for the live members, then
 * `MGET` their snapshot keys. A member without a value (expired between the
 * two calls, or pruned by a concurrent beat) is dropped rather than reported
 * as a hole — the index is a hint, not a guarantee, by design (see
 * `telemetry-keys.ts`).
 */
async function readIndexed<T>(
  redis: TelemetryRedisClient,
  indexKey: string,
  minScore: number,
  keyFor: (member: string) => string,
): Promise<T[]> {
  const members = await redis.zrangebyscore(indexKey, minScore, '+inf');
  if (members.length === 0) return [];

  const values = await redis.mget(members.map(keyFor));
  return values
    .filter((v): v is string => v !== null)
    .map((v) => JSON.parse(v) as T);
}

const PROVIDER_STATUS_RANK = { ok: 0, degraded: 1, down: 2 } as const;

/**
 * Merges the same `providerKey` across every Transcription Service host
 * reporting it into one card. A provider is served by >=1 host, so its
 * global status is the best any single host reports — `down` only when every
 * host serving it is `down`, `ok` only when every host is.
 */
function mergeProviders(hosts: TranscriptionHostSnapshot[]): MergedProvider[] {
  const byKey = new Map<string, MergedProvider>();

  for (const host of hosts) {
    for (const [providerKey, health] of Object.entries(host.providers)) {
      const existing = byKey.get(providerKey);
      const entry = { transcriptionHost: host.transcriptionHost, health };

      if (existing === undefined) {
        byKey.set(providerKey, {
          providerKey,
          status: health.status,
          activeSessions: health.activeSessions,
          hosts: [entry],
        });
        continue;
      }

      existing.hosts.push(entry);
      existing.activeSessions += health.activeSessions;
      if (
        PROVIDER_STATUS_RANK[health.status] <
        PROVIDER_STATUS_RANK[existing.status]
      ) {
        existing.status = health.status;
      }
    }
  }

  return [...byKey.values()];
}
