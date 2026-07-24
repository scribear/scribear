import { Redis } from 'ioredis';
import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';

import type { ChannelDefinition } from './types.js';

export interface RedisSubscriber<T extends TSchema, TArgs extends unknown[]> {
  subscribe(listener: (message: Static<T>) => void, ...keyArgs: TArgs): void;
  unsubscribe(...keyArgs: TArgs): void;
  disconnect(): Promise<void>;
}

/**
 * Creates a typed Redis subscriber for a specific channel definition.
 * Incoming messages are validated against the schema before delivery.
 * Messages that fail validation are logged and dropped.
 *
 * @param channelDef - Channel definition with schema and key builder.
 * @param redisUrl - Redis connection URL.
 */
export function createRedisSubscriber<
  T extends TSchema,
  TArgs extends unknown[],
>(
  channelDef: ChannelDefinition<T, TArgs>,
  redisUrl: string,
): RedisSubscriber<T, TArgs> {
  // Disable ready check: ioredis sends an INFO command on reconnect, but
  // subscriber-mode connections only allow subscriber commands.
  const redis = new Redis(redisUrl, { enableReadyCheck: false });
  const listeners = new Map<string, (message: Static<T>) => void>();

  // An ioredis client with no `error` listener treats a connection failure
  // (unreachable host, WRONGPASS) as an unhandled error and takes the whole
  // process down with it. For a consumer like the admin `/fleet/stream` path
  // that is exactly backwards: a telemetry backplane it cannot reach should
  // cost the stream its events, not crash the server that hosts it. This is
  // the same guarantee `createTelemetryRedisClient` requires of its callers,
  // made here because this factory owns its client rather than handing it out.
  redis.on('error', (err: Error) => {
    console.warn(`[redis-subscriber] connection error: ${err.message}`);
  });

  redis.on('message', (channelKey: string, rawMessage: string) => {
    const listener = listeners.get(channelKey);
    if (!listener) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMessage) as unknown;
    } catch {
      console.warn(
        `[redis-subscriber] Failed to parse message on channel "${channelKey}"`,
      );
      return;
    }

    if (!Value.Check(channelDef.schema, parsed)) {
      console.warn(
        `[redis-subscriber] Message on channel "${channelKey}" failed schema validation`,
      );
      return;
    }

    listener(parsed);
  });

  return {
    subscribe(listener: (message: Static<T>) => void, ...keyArgs: TArgs): void {
      const channelKey = channelDef.key(...keyArgs);
      listeners.set(channelKey, listener);
      // `.catch`, not `void`: a rejected SUBSCRIBE (auth failure, connection
      // lost before it lands) is otherwise an unhandled rejection, which under
      // Node's default crashes the process. The `error` listener above handles
      // the connection-level event; this handles the command promise.
      redis.subscribe(channelKey).catch((err: Error) => {
        console.warn(
          `[redis-subscriber] failed to subscribe to "${channelKey}": ${err.message}`,
        );
      });
    },

    unsubscribe(...keyArgs: TArgs): void {
      const channelKey = channelDef.key(...keyArgs);
      listeners.delete(channelKey);
      redis.unsubscribe(channelKey).catch((err: Error) => {
        console.warn(
          `[redis-subscriber] failed to unsubscribe from "${channelKey}": ${err.message}`,
        );
      });
    },

    disconnect(): Promise<void> {
      listeners.clear();
      // `disconnect()`, not `quit()`: `quit` is an ordinary Redis command, so
      // if the connection never established (wrong URL, host unreachable) it
      // sits in the offline queue behind the `subscribe` this class issues on
      // every construction, waiting on a reconnect loop that retries forever
      // by default - hanging shutdown on exactly the case a subscriber is
      // most likely to be torn down in. `disconnect()` is synchronous and
      // closes the socket immediately, with nothing here worth waiting for.
      redis.disconnect();
      return Promise.resolve();
    },
  };
}
