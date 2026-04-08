import { Redis } from 'ioredis';
import type { Static, TSchema } from 'typebox';

import type { ChannelDefinition } from './types.js';

export interface RedisPublisher<T extends TSchema, TArgs extends unknown[]> {
  publish(message: Static<T>, ...keyArgs: TArgs): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * Creates a typed Redis publisher for a specific channel definition.
 * The channel definition provides both message typing and key construction.
 *
 * @param channelDef - Channel definition with schema and key builder.
 * @param redisUrl - Redis connection URL.
 */
export function createRedisPublisher<
  T extends TSchema,
  TArgs extends unknown[],
>(
  channelDef: ChannelDefinition<T, TArgs>,
  redisUrl: string,
): RedisPublisher<T, TArgs> {
  const redis = new Redis(redisUrl);

  return {
    async publish(message: Static<T>, ...keyArgs: TArgs): Promise<void> {
      const channelKey = channelDef.key(...keyArgs);
      await redis.publish(channelKey, JSON.stringify(message));
    },

    async disconnect(): Promise<void> {
      await redis.quit();
    },
  };
}
