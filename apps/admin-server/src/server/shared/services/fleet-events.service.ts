import type {
  FLEET_EVENT_SCHEMA,
  FleetEvent,
  RedisSubscriber,
} from '@scribear/scribear-redis';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

/** A connected SSE client's forwarding function. */
export type FleetEventListener = (event: FleetEvent) => void;

/**
 * Fans out `scribe:v1:events` (B1.7 §2.5) to every connected `/fleet/stream`
 * client. Read-only counterpart to node-server's delta publish - the first and
 * only consumer of the typed pub/sub half of the backplane 2a brought back.
 *
 * Takes the subscriber pre-built rather than a `redisUrl`, matching
 * `FleetTelemetryService`: the factory in `register-dependencies.ts` is where
 * `REDIS_URL` unset becomes "build no subscriber at all," so this class never
 * has to decide whether to open one. Same reason the subscriber is a plain
 * constructor argument rather than a named `AppDependencies` member -
 * `resolveHandler`'s generic bound assumes every named dependency is
 * non-nullable, and a `RedisSubscriber | null` member would break that for
 * every route, not just this one.
 */
export class FleetEventsService {
  private _subscriber: RedisSubscriber<typeof FLEET_EVENT_SCHEMA, []> | null;
  private _logger: AppDependencies['logger'];
  private _listeners = new Set<FleetEventListener>();

  /** False when `REDIS_URL` is unset - no connection was ever opened. */
  readonly enabled: boolean;

  constructor(
    fleetEventsRedisSubscriber: RedisSubscriber<
      typeof FLEET_EVENT_SCHEMA,
      []
    > | null,
    logger: AppDependencies['logger'],
  ) {
    this._subscriber = fleetEventsRedisSubscriber;
    this._logger = logger;
    this.enabled = fleetEventsRedisSubscriber !== null;

    // Subscribed once, immediately: a message published while nobody is
    // listening is simply lost (pub/sub has no history), so there is nothing
    // to gain by waiting for the first SSE client - and every later client
    // reuses this same subscription rather than opening its own.
    this._subscriber?.subscribe((event) => {
      for (const listener of this._listeners) {
        try {
          listener(event);
        } catch (err) {
          this._logger.error({ err }, 'fleet stream listener threw');
        }
      }
    });
  }

  /** Registers an SSE client's forwarder. Returns an unregister function. */
  addListener(listener: FleetEventListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this._listeners.clear();
    await this._subscriber?.disconnect().catch(() => {
      // Already disconnected, or never connected.
    });
  }
}
