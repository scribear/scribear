import { Type } from 'typebox';
import { afterEach, describe, expect, inject } from 'vitest';

import { createRedisPublisher } from '#src/pubsub/create-redis-publisher.js';
import { createRedisSubscriber } from '#src/pubsub/create-redis-subscriber.js';

const TEST_CHANNEL = {
  schema: Type.Object({
    type: Type.Literal('TEST_EVENT'),
    value: Type.Number(),
  }),
  key: (name: string) => `test:${name}`,
};

type TestPublisher = ReturnType<
  typeof createRedisPublisher<typeof TEST_CHANNEL.schema, [name: string]>
>;
type TestSubscriber = ReturnType<
  typeof createRedisSubscriber<typeof TEST_CHANNEL.schema, [name: string]>
>;

describe('Redis pub/sub integration', (it) => {
  let publisher: TestPublisher;
  let subscriber: TestSubscriber;

  afterEach(async () => {
    await publisher.disconnect();
    await subscriber.disconnect();
  });

  it('delivers a published message to a subscriber', async () => {
    // Arrange
    const redisUrl = inject('redisUrl');
    publisher = createRedisPublisher(TEST_CHANNEL, redisUrl);
    subscriber = createRedisSubscriber(TEST_CHANNEL, redisUrl);

    const received = new Promise<unknown>((resolve) => {
      subscriber.subscribe(resolve, 'integration');
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });

    // Act
    const message = { type: 'TEST_EVENT' as const, value: 123 };
    await publisher.publish(message, 'integration');

    // Assert
    const result = await received;
    expect(result).toEqual(message);
  });

  it('does not deliver messages to unsubscribed channels', async () => {
    // Arrange
    const redisUrl = inject('redisUrl');
    publisher = createRedisPublisher(TEST_CHANNEL, redisUrl);
    subscriber = createRedisSubscriber(TEST_CHANNEL, redisUrl);

    let receivedMessage = false;
    subscriber.subscribe(() => {
      receivedMessage = true;
    }, 'unsub');
    subscriber.unsubscribe('unsub');
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });

    // Act
    await publisher.publish({ type: 'TEST_EVENT', value: 456 }, 'unsub');
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    // Assert
    expect(receivedMessage).toBe(false);
  });

  it('delivers messages only to the correct channel', async () => {
    // Arrange
    const redisUrl = inject('redisUrl');
    publisher = createRedisPublisher(TEST_CHANNEL, redisUrl);
    subscriber = createRedisSubscriber(TEST_CHANNEL, redisUrl);

    const receivedOnA: unknown[] = [];
    const receivedOnB: unknown[] = [];
    subscriber.subscribe((msg) => {
      receivedOnA.push(msg);
    }, 'channel-a');
    subscriber.subscribe((msg) => {
      receivedOnB.push(msg);
    }, 'channel-b');
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });

    // Act
    await publisher.publish({ type: 'TEST_EVENT', value: 1 }, 'channel-a');
    await publisher.publish({ type: 'TEST_EVENT', value: 2 }, 'channel-b');
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    // Assert
    expect(receivedOnA).toEqual([{ type: 'TEST_EVENT', value: 1 }]);
    expect(receivedOnB).toEqual([{ type: 'TEST_EVENT', value: 2 }]);
  });

  it('drops messages that fail schema validation', async () => {
    // Arrange
    const redisUrl = inject('redisUrl');
    publisher = createRedisPublisher(TEST_CHANNEL, redisUrl);
    subscriber = createRedisSubscriber(TEST_CHANNEL, redisUrl);

    const received: unknown[] = [];
    subscriber.subscribe((msg) => {
      received.push(msg);
    }, 'validation');
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });

    // Act
    await publisher.publish({ type: 'TEST_EVENT', value: 42 }, 'validation');
    const { Redis } = await import('ioredis');
    const rawRedis = new Redis(redisUrl);
    await rawRedis.publish(
      'test:validation',
      JSON.stringify({ type: 'WRONG', value: 'not-a-number' }),
    );
    await rawRedis.quit();
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    // Assert
    expect(received).toEqual([{ type: 'TEST_EVENT', value: 42 }]);
  });
});
