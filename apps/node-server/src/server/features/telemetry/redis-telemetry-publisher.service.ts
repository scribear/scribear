import { STATUS_MAX_SESSIONS } from '@scribear/node-server-schema';
import {
  FLEET_EVENTS_CHANNEL_KEY,
  type FleetEvent,
  NODE_HEARTBEAT_MS,
  NODE_INDEX_KEY,
  NODE_TTL_MS,
  type NodeSnapshot,
  SESSION_INDEX_KEY,
  type SessionSnapshot,
  nodeSnapshotKey,
  sessionRouteKey,
  sessionSnapshotKey,
} from '@scribear/scribear-redis';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { FleetStatusDeltaChannel } from '#src/server/features/transcription-stream/events/fleet-status-delta.events.js';
import type { FleetStatusDelta } from '#src/server/features/transcription-stream/events/fleet-status-delta.events.js';

/**
 * Publishes this instance's telemetry to the Redis backplane every heartbeat
 * (B1.7 §2.3).
 *
 * **Why publish at all**, when `GET /status` already reports the same numbers:
 * past ~100 rooms the fleet runs several Node Server instances and sticky
 * routing pins each session to exactly one of them, so no single instance can
 * answer "what is the fleet doing". A dashboard that fanned out over instances
 * would need to know how many there are, and could not tell an instance it
 * failed to reach from one with no rooms. Publishing inverts that: every
 * instance writes what it knows, and the reader's cost stops depending on the
 * instance count.
 *
 * **Liveness is expiry.** Each write carries a TTL of five heartbeats and
 * nothing here ever deletes: an instance that stops writing stops existing,
 * which is what makes a `kill -9`'d instance's rooms leave the fleet view with
 * no cleanup path to get wrong. The corollary is that this publishes *all* of
 * its keys every beat, including sessions that have not changed - it is a
 * heartbeat, not a change feed.
 *
 * **It must never affect transcription.** Every failure mode here - Redis
 * down, slow, or misconfigured - is caught and logged, the connection refuses
 * to queue commands offline, and no caller awaits a publish. The cost of
 * losing Redis is that the dashboard loses its cross-instance view; the cost
 * to a session is nothing.
 */
export class RedisTelemetryPublisher {
  private _redis: AppDependencies['telemetryRedisClient'];
  private _snapshots: AppDependencies['statusSnapshotService'];
  private _eventBus: AppDependencies['eventBusService'];
  private _logger: AppDependencies['logger'];
  private _nodeInstanceId: string;

  private _timer: ReturnType<typeof setInterval> | null = null;
  private _unsubscribeDelta: (() => void) | null = null;
  /**
   * Set while a beat is in flight. A beat that outruns the interval is skipped
   * rather than queued: the next one rewrites the same keys with fresher
   * numbers, so queueing would only publish a backlog of stale snapshots.
   */
  private _publishing = false;
  /**
   * Latches once a failure has been logged, and clears on the next success, so
   * an outage costs one warning rather than one every two seconds. The
   * recovery is logged too, which is what makes the pair readable as a window.
   */
  private _failureLogged = false;

  constructor(
    telemetryRedisClient: AppDependencies['telemetryRedisClient'],
    statusSnapshotService: AppDependencies['statusSnapshotService'],
    telemetryPublisherConfig: AppDependencies['telemetryPublisherConfig'],
    logger: AppDependencies['logger'],
    eventBusService: AppDependencies['eventBusService'],
  ) {
    this._redis = telemetryRedisClient;
    this._snapshots = statusSnapshotService;
    this._nodeInstanceId = telemetryPublisherConfig.nodeInstanceId;
    this._logger = logger;
    this._eventBus = eventBusService;
  }

  /**
   * Begins publishing.
   *
   * A beat also fires on every `ready`, which covers both boot and every
   * reconnection: the client refuses to queue commands while disconnected, so
   * publishing on connect is what puts this instance back in the fleet view
   * immediately rather than up to a heartbeat later - and, at boot, is what
   * keeps the first beat from failing against a connection that is still being
   * established.
   */
  start(): void {
    if (this._timer !== null) return;

    // An ioredis client with no `error` listener treats a connection failure as
    // an unhandled error and takes the process down with it, which for the
    // telemetry path would be exactly backwards. Debug, not warn: the client
    // retries forever with backoff and emits one of these per attempt, while
    // the beat below already reports the outage once.
    this._redis.on('error', (err) => {
      this._logger.debug({ err }, 'telemetry redis connection error');
    });
    this._redis.on('ready', () => {
      void this.publishOnce();
    });

    this._logger.info(
      {
        nodeInstanceId: this._nodeInstanceId,
        heartbeatMs: NODE_HEARTBEAT_MS,
      },
      'publishing telemetry to the fleet backplane',
    );

    this._timer = setInterval(() => {
      void this.publishOnce();
    }, NODE_HEARTBEAT_MS);
    // Do not hold the event loop open on this timer alone.
    this._timer.unref();

    // Sub-second push (B1.7 §2.5): forwards every session status transition
    // to `scribe:v1:events` as it happens, rather than waiting for the next
    // heartbeat to carry it. Subscribed only once telemetry is switched on,
    // same as the heartbeat itself - the orchestrator publishes this
    // in-process regardless, at no cost, whether or not anyone is listening.
    this._unsubscribeDelta = this._eventBus.subscribe(
      FleetStatusDeltaChannel,
      (delta) => {
        void this._publishDelta(delta);
      },
    );
  }

  /**
   * Stops publishing and closes the connection. The keys are deliberately left
   * behind: they expire within seconds on their own, and deleting them would
   * make a graceful restart look momentarily like an instance that never
   * existed, while a crash - which cannot delete anything - would not.
   */
  async stop(): Promise<void> {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._unsubscribeDelta !== null) {
      this._unsubscribeDelta();
      this._unsubscribeDelta = null;
    }
    await this._redis.quit().catch(() => {
      // Already disconnected, or never connected. Nothing to close.
    });
  }

  /**
   * Publishes one beat: this instance's own record, one record per live
   * session, and the route entry naming this instance as the session's owner.
   *
   * Exposed rather than private so tests can drive a beat deterministically
   * instead of waiting on the interval.
   */
  async publishOnce(): Promise<void> {
    if (this._publishing) return;
    this._publishing = true;
    try {
      const now = Date.now();
      const process = this._snapshots.process();
      // Capped at the same limit `/status` uses. `summary.activeSessionCount`
      // in the instance record below is the authoritative total, so a reader
      // seeing fewer session records than that is looking at a truncated or
      // partially expired fleet rather than at rooms that ended.
      const { sessions } = this._snapshots.sessions(STATUS_MAX_SESSIONS);

      // A pipeline, not a MULTI: these writes have no invariant between them
      // that a reader could observe being broken - every one of them is an
      // idempotent overwrite of the same value the next beat will write again.
      const beat = this._redis.pipeline();

      for (const session of sessions) {
        const record: SessionSnapshot = {
          ...session,
          nodeInstanceId: this._nodeInstanceId,
          processUid: process.processUid,
          updatedAt: now,
        };
        beat.set(
          sessionSnapshotKey(session.sessionUid),
          JSON.stringify(record),
          'PX',
          NODE_TTL_MS,
        );
        beat.zadd(SESSION_INDEX_KEY, now, session.sessionUid);
        beat.set(
          sessionRouteKey(session.sessionUid),
          this._nodeInstanceId,
          'PX',
          NODE_TTL_MS,
        );
      }

      const instance: NodeSnapshot = {
        ...process,
        nodeInstanceId: this._nodeInstanceId,
        updatedAt: now,
      };
      beat.set(
        nodeSnapshotKey(this._nodeInstanceId),
        JSON.stringify(instance),
        'PX',
        NODE_TTL_MS,
      );
      beat.zadd(NODE_INDEX_KEY, now, this._nodeInstanceId);

      // Sorted-set members carry no TTL of their own, so an index would
      // otherwise grow forever with the uid of every session the fleet has
      // ever run. Pruning is by score and therefore not scoped to this
      // instance: whoever beats next drops whatever has expired, which is also
      // what clears an instance that died without unregistering.
      beat.zremrangebyscore(SESSION_INDEX_KEY, 0, now - NODE_TTL_MS);
      beat.zremrangebyscore(NODE_INDEX_KEY, 0, now - NODE_TTL_MS);

      const results = await beat.exec();
      // `exec` resolves rather than rejects when individual commands fail, so
      // a partial write is only visible by inspecting the replies.
      const failure = results?.find(([err]) => err !== null)?.[0];
      if (failure) throw failure;

      if (this._failureLogged) {
        this._failureLogged = false;
        this._logger.info('telemetry publishing recovered');
      }
    } catch (err) {
      if (!this._failureLogged) {
        this._failureLogged = true;
        this._logger.warn(
          { err },
          'telemetry publish failed; this instance will age out of the fleet view until it recovers',
        );
      }
    } finally {
      this._publishing = false;
    }
  }

  /**
   * Forwards one session status transition to `scribe:v1:events`. A plain
   * `PUBLISH` on the existing heartbeat connection - no dedicated connection
   * needed, since only `SUBSCRIBE` puts a connection in a mode that cannot
   * issue other commands.
   *
   * Errors are swallowed like every other Redis call here: a dropped delta
   * costs a subscriber one heartbeat's worth of staleness at most, never a
   * session.
   */
  private async _publishDelta(delta: FleetStatusDelta): Promise<void> {
    try {
      const event: FleetEvent = { t: 'session', ...delta };
      await this._redis.publish(
        FLEET_EVENTS_CHANNEL_KEY,
        JSON.stringify(event),
      );
    } catch (err) {
      this._logger.debug({ err }, 'fleet event publish failed');
    }
  }
}
