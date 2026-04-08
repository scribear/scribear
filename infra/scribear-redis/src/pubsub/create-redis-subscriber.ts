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
  const redis = new Redis(redisUrl);
  const listeners = new Map<string, (message: Static<T>) => void>();

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
      void redis.subscribe(channelKey);
    },

    unsubscribe(...keyArgs: TArgs): void {
      const channelKey = channelDef.key(...keyArgs);
      listeners.delete(channelKey);
      void redis.unsubscribe(channelKey);
    },

    async disconnect(): Promise<void> {
      listeners.clear();
      await redis.quit();
    },
  };
}
