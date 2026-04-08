import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_CHANNEL_DEF = {
  schema: Type.Object({
    type: Type.Literal('TEST_EVENT'),
    value: Type.Number(),
  }),
  key: (name: string) => `test:${name}`,
};

let mockRedisInstance: {
  publish: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
};

vi.mock('ioredis', () => ({
  Redis: function MockRedis() {
    return mockRedisInstance;
  },
}));

let createRedisPublisher: typeof import('#src/pubsub/create-redis-publisher.js').createRedisPublisher;

beforeEach(async () => {
  mockRedisInstance = {
    publish: vi
      .fn<(channel: string, message: string) => Promise<number>>()
      .mockResolvedValue(1),
    quit: vi.fn<() => Promise<string>>().mockResolvedValue('OK'),
  };

  vi.resetModules();
  const mod = await import('#src/pubsub/create-redis-publisher.js');
  createRedisPublisher = mod.createRedisPublisher;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createRedisPublisher', () => {
  it('should publish a JSON-serialized message to the constructed key', async () => {
    // Arrange
    const publisher = createRedisPublisher(
      TEST_CHANNEL_DEF,
      'redis://localhost:6379',
    );

    // Act
    await publisher.publish({ type: 'TEST_EVENT', value: 42 }, 'channel');

    // Assert
    expect(mockRedisInstance.publish).toHaveBeenCalledWith(
      'test:channel',
      JSON.stringify({ type: 'TEST_EVENT', value: 42 }),
    );
  });

  it('should use the key builder with the provided arguments', async () => {
    // Arrange
    const publisher = createRedisPublisher(
      TEST_CHANNEL_DEF,
      'redis://localhost:6379',
    );

    // Act
    await publisher.publish({ type: 'TEST_EVENT', value: 1 }, 'session-abc');

    // Assert
    expect(mockRedisInstance.publish).toHaveBeenCalledWith(
      'test:session-abc',
      expect.any(String),
    );
  });

  it('should call redis.quit on disconnect', async () => {
    // Arrange
    const publisher = createRedisPublisher(
      TEST_CHANNEL_DEF,
      'redis://localhost:6379',
    );

    // Act
    await publisher.disconnect();

    // Assert
    expect(mockRedisInstance.quit).toHaveBeenCalled();
  });
});
