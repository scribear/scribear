import {
  AUDIO_STATS_TTL_MS,
  NODE_INDEX_KEY,
  NODE_TTL_MS,
  type NodeSnapshot,
  type ProviderHealth,
  SESSION_INDEX_KEY,
  type SessionAudioSnapshot,
  type SessionSnapshot,
  type SnapshotParseResult,
  TRANSCRIPTION_HOST_INDEX_KEY,
  TRANSCRIPTION_HOST_TTL_MS,
  TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
  type TelemetryRedisClient,
  type TranscriptionHostSnapshot,
  nodeSnapshotKey,
  parseSessionAudioSnapshot,
  sessionSnapshotKey,
  transcriptionHostSnapshotKey,
  transcriptionSessionAudioKey,
} from '@scribear/scribear-redis';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

export interface FleetTelemetryConfig {
  redisUrl: string;
}

/**
 * Turns one raw index value into a snapshot, or reports why it could not be.
 * The parsers `@scribear/scribear-redis` exports beside each schema have this
 * shape — see `parseSessionAudioSnapshot`.
 */
type SnapshotParser<T> = (raw: string) => SnapshotParseResult<T>;

/** The failing half of a parse result — everything a drop has to report. */
type SnapshotParseFailure = Extract<
  SnapshotParseResult<unknown>,
  { ok: false }
>;

/** One index member whose value was dropped, and the parser's reason. */
interface DroppedSnapshot extends Omit<SnapshotParseFailure, 'ok'> {
  member: string;
}

/**
 * Minimum gap between validation-drop log lines for one index.
 *
 * A shape drift is not a transient: the publisher keeps writing the same wrong
 * shape, so every member of that index fails on every read, and `/fleet` is
 * polled every few seconds by every open dashboard. Logging each drop as it
 * happens would turn one deployment mistake into hundreds of identical lines a
 * minute and bury the one line that explains it. One line per index per
 * minute, carrying how many drops it stands for, says the same thing and stays
 * readable.
 *
 * Exported only so the test covering the throttle does not have to restate the
 * number and drift from it.
 */
export const VALIDATION_DROP_LOG_INTERVAL_MS = 60_000;

/**
 * How many dropped members one log line names. A drift affects every member of
 * an index identically, so the first few are representative and the rest are
 * the same complaint against a different session id — and each already carries
 * the parser's own capped list of validator messages.
 */
const MAX_LOGGED_DROPS = 3;

/**
 * Parser for an index whose values are still trusted: JSON only, no shape
 * check. This is what `_readIndexed` did to every index before PLAN-AUDIOVIZ
 * §12.5, and `nodes`, `sessions` and `transcriptionHosts` still pass it — so
 * `NodeSnapshot`, `SessionSnapshot` and `TranscriptionHostSnapshot` are cast,
 * not validated, and a field that changes in their publishers still reaches
 * the dashboard as `undefined`. §12.5 scopes converting those three out
 * deliberately; doing it later means exporting a parser beside each of those
 * schemas and naming it at that call site instead of this function, and
 * nothing else.
 *
 * The `try` is not optional even without a shape check: a value that is not
 * JSON at all used to throw out of the `MGET` loop and cost the caller the
 * whole `/fleet` response, which is the same all-or-nothing failure the
 * validating path exists to avoid.
 */
function parseUnvalidated<T>(raw: string): SnapshotParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (error) {
    return {
      ok: false,
      reason: 'malformed-json',
      errors: [
        error instanceof Error ? error.message : 'JSON.parse threw a non-Error',
      ],
    };
  }
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
  /**
   * Latest per-stage audio telemetry per live session, from Transcription
   * Service's own index — deliberately NOT joined to `sessions` (D2 of
   * PLAN-AUDIOVIZ: the two publishers do not coordinate, and both asymmetries
   * — session present without audio, audio present without session — are
   * signals, not noise).
   */
  sessionAudio: SessionAudioSnapshot[];
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

  /**
   * Log throttle state for `_logDroppedSnapshots`, one entry per index key —
   * four at most, so it cannot grow with fleet size the way a per-session or
   * per-error key would.
   */
  private _dropLog = new Map<
    string,
    { lastLoggedAt: number; suppressed: number }
  >();

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

    const [nodes, sessions, transcriptionHosts, sessionAudio] =
      await Promise.all([
        this._readIndexed<NodeSnapshot>(
          redis,
          NODE_INDEX_KEY,
          now - NODE_TTL_MS,
          nodeSnapshotKey,
          parseUnvalidated,
        ),
        this._readIndexed<SessionSnapshot>(
          redis,
          SESSION_INDEX_KEY,
          now - NODE_TTL_MS,
          sessionSnapshotKey,
          parseUnvalidated,
        ),
        this._readIndexed<TranscriptionHostSnapshot>(
          redis,
          TRANSCRIPTION_HOST_INDEX_KEY,
          now - TRANSCRIPTION_HOST_TTL_MS,
          transcriptionHostSnapshotKey,
          parseUnvalidated,
        ),
        this._readIndexed<SessionAudioSnapshot>(
          redis,
          TRANSCRIPTION_SESSION_AUDIO_INDEX_KEY,
          // 10 s, and NOT `NODE_TTL_MS` even though the two are equal today:
          // this index is written by a different publisher on a different
          // cadence, and its interval is documented as provisional
          // (`telemetry-timing.ts`). Reusing the constant that happens to
          // match the number is how the two silently become one.
          now - AUDIO_STATS_TTL_MS,
          transcriptionSessionAudioKey,
          parseSessionAudioSnapshot,
        ),
      ]);

    return {
      generatedAt: now,
      nodes,
      sessions,
      transcriptionHosts,
      providers: mergeProviders(transcriptionHosts),
      sessionAudio,
    };
  }

  /**
   * `ZRANGEBYSCORE <indexKey> <minScore> +inf` for the live members, then
   * `MGET` their snapshot keys. A member without a value (expired between the
   * two calls, or pruned by a concurrent beat) is dropped rather than reported
   * as a hole — the index is a hint, not a guarantee, by design (see
   * `telemetry-keys.ts`).
   *
   * A value `parse` rejects is dropped the same way, and logged, for the same
   * reason: one bad snapshot must cost an operator one member's telemetry
   * rather than the entire `/fleet` response. `parse` is what decides what
   * "bad" means — a validating parser rejects a payload whose shape has
   * drifted from the schema it was written against, `parseUnvalidated` only
   * rejects a value that is not JSON.
   *
   * `parse` is required rather than optional: an index reading its values
   * without validation is a choice worth making at each call site, not a
   * default that three of the four fell into.
   *
   * `redis` is a parameter rather than read from `this._redis` because the
   * caller has already proved it non-null; reading the field here would force
   * a redundant null check per index.
   */
  private async _readIndexed<T>(
    redis: TelemetryRedisClient,
    indexKey: string,
    minScore: number,
    keyFor: (member: string) => string,
    parse: SnapshotParser<T>,
  ): Promise<T[]> {
    const members = await redis.zrangebyscore(indexKey, minScore, '+inf');
    if (members.length === 0) return [];

    const values = await redis.mget(members.map(keyFor));
    const snapshots: T[] = [];
    const dropped: DroppedSnapshot[] = [];

    for (const [index, member] of members.entries()) {
      // `undefined` only satisfies `noUncheckedIndexedAccess` — MGET answers
      // with exactly one entry per key requested. `null` is the expired key.
      const value = values[index];
      if (value === undefined || value === null) continue;

      const result = parse(value);
      if (result.ok) {
        snapshots.push(result.value);
        continue;
      }
      dropped.push({
        member,
        reason: result.reason,
        errors: result.errors,
      });
    }

    if (dropped.length > 0) this._logDroppedSnapshots(indexKey, dropped);
    return snapshots;
  }

  /**
   * One line per index per `VALIDATION_DROP_LOG_INTERVAL_MS`, naming the index,
   * a sample of the members dropped and what the parser objected to — the three
   * things needed to identify the publisher at fault.
   *
   * `warn`, not the `debug` the connection-error listener above uses: a
   * connection error announces itself anyway (the caller gets a 503 and
   * `/health` reports redis down), whereas a validation drop serves a 200 whose
   * data is quietly incomplete and which nothing else in the system mentions.
   */
  private _logDroppedSnapshots(
    indexKey: string,
    dropped: DroppedSnapshot[],
  ): void {
    const now = Date.now();
    const previous = this._dropLog.get(indexKey);

    if (
      previous !== undefined &&
      now - previous.lastLoggedAt < VALIDATION_DROP_LOG_INTERVAL_MS
    ) {
      previous.suppressed += dropped.length;
      return;
    }

    this._dropLog.set(indexKey, { lastLoggedAt: now, suppressed: 0 });
    this._logger.warn(
      {
        indexKey,
        droppedCount: dropped.length,
        suppressedSinceLastLog: previous?.suppressed ?? 0,
        droppedSample: dropped.slice(0, MAX_LOGGED_DROPS),
      },
      'dropped fleet telemetry snapshots that failed to parse',
    );
  }
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
