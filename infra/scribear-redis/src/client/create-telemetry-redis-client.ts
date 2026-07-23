import { Redis } from 'ioredis';

/**
 * A Redis connection for the telemetry backplane.
 *
 * The typed pub/sub helpers each own their connection because a subscriber
 * connection cannot issue ordinary commands; the snapshot half of the
 * backplane is plain keys and sorted sets, so it needs a client rather than a
 * channel, and this is where the connection options for that live.
 *
 * Two of those options differ from ioredis defaults, both for the same reason:
 * nothing on this connection is worth waiting for. Every value published to it
 * is a snapshot superseded by the next heartbeat, and every read of it answers
 * a dashboard poll that will be repeated.
 *
 * - `enableOfflineQueue: false` — by default ioredis buffers commands issued
 *   while disconnected and replays them on reconnect. For a heartbeat that
 *   would grow unboundedly through an outage and then flush a burst of stale
 *   snapshots, each overwriting the last, at the moment the fleet is least
 *   healthy. Failing the command immediately is what makes "Redis is down"
 *   cost a caller one caught error per beat instead of memory.
 * - `maxRetriesPerRequest: 0` — a command that reached a live connection and
 *   did not answer is not retried. The next beat rewrites the same keys
 *   anyway, so a retry only delays that.
 *
 * The cost of refusing the offline queue is that a command issued before the
 * first connection completes fails like any other issued while disconnected -
 * connecting is asynchronous and nothing waits for it. Callers that want their
 * first write to land should issue it from the client's `ready` event, which
 * also covers every reconnection after an outage.
 *
 * Reconnection itself is left at the ioredis default: the client keeps trying
 * to re-establish the connection forever with backoff, which is what lets a
 * publisher survive a Redis restart without a restart of its own.
 *
 * Callers must attach an `error` listener. An ioredis client with no listener
 * treats connection errors as unhandled and takes the process down with them,
 * which for a telemetry sidecar path would be exactly backwards.
 *
 * @param redisUrl Connection URL, including credentials.
 */
export function createTelemetryRedisClient(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
  });
}

/** The client type returned by {@link createTelemetryRedisClient}. */
export type TelemetryRedisClient = Redis;
