import { EventEmitter } from 'events';
import { Type } from 'typebox';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_CHANNEL_DEF = {
  schema: Type.Object({
    type: Type.Literal('TEST_EVENT'),
    value: Type.Number(),
  }),
  key: (name: string) => `test:${name}`,
};

let mockRedisInstance: EventEmitter & {
  subscribe: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
};

vi.mock('ioredis', () => ({
  Redis: function MockRedis() {
    return mockRedisInstance;
  },
}));

let createRedisSubscriber: typeof import('#src/pubsub/create-redis-subscriber.js').createRedisSubscriber;

beforeEach(async () => {
  const emitter = new EventEmitter();
  mockRedisInstance = Object.assign(emitter, {
    subscribe: vi
      .fn<(channel: string) => Promise<number>>()
      .mockResolvedValue(1),
    unsubscribe: vi
      .fn<(channel: string) => Promise<number>>()
      .mockResolvedValue(1),
    quit: vi.fn<() => Promise<string>>().mockResolvedValue('OK'),
  });

  vi.resetModules();
  const mod = await import('#src/pubsub/create-redis-subscriber.js');
  createRedisSubscriber = mod.createRedisSubscriber;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createRedisSubscriber', () => {
  it('should call redis.subscribe with the constructed key', () => {
    // Arrange
    const subscriber = createRedisSubscriber(
      TEST_CHANNEL_DEF,
      'redis://localhost:6379',
    );

    // Act
    subscriber.subscribe(vi.fn(), 'channel');

    // Assert
    expect(mockRedisInstance.subscribe).toHaveBeenCalledWith('test:channel');
  });

  it('should call redis.unsubscribe with the constructed key', () => {
    // Arrange
    const subscriber = createRedisSubscriber(
      TEST_CHANNEL_DEF,
      'redis://localhost:6379',
    );
    subscriber.subscribe(vi.fn(), 'channel');

    // Act
    subscriber.unsubscribe('channel');

    // Assert
    expect(mockRedisInstance.unsubscribe).toHaveBeenCalledWith('test:channel');
  });

  it('should deliver valid messages to the listener', () => {
    // Arrange
    const subscriber = createRedisSubscriber(
      TEST_CHANNEL_DEF,
      'redis://localhost:6379',
    );
    const listener = vi.fn();
    subscriber.subscribe(listener, 'channel');
    const message = { type: 'TEST_EVENT', value: 42 };

    // Act
    mockRedisInstance.emit('message', 'test:channel', JSON.stringify(message));

    // Assert
    expect(listener).toHaveBeenCalledWith(message);
  });

  it('should drop messages that fail schema validation', () => {
    // Arrange
    const subscriber = createRedisSubscriber(
      TEST_CHANNEL_DEF,
      'redis://localhost:6379',
    );
    const listener = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockReturnValue(undefined);
    subscriber.subscribe(listener, 'channel');

    // Act
    mockRedisInstance.emit(
      'message',
      'test:channel',
      JSON.stringify({ type: 'TEST_EVENT' }),
    );

    // Assert
    expect(listener).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed schema validation'),
    );
  });

  it('should drop messages with invalid JSON', () => {
    // Arrange
    const subscriber = createRedisSubscriber(
      TEST_CHANNEL_DEF,
      'redis://localhost:6379',
    );
    const listener = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockReturnValue(undefined);
    subscriber.subscribe(listener, 'channel');

    // Act
    mockRedisInstance.emit('message', 'test:channel', 'not-valid-json');

    // Assert
    expect(listener).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to parse'),
    );
  });

  it('should ignore messages for unsubscribed channels', () => {
    // Arrange
    const subscriber = createRedisSubscriber(
      TEST_CHANNEL_DEF,
      'redis://localhost:6379',
    );
    const listener = vi.fn();
    subscriber.subscribe(listener, 'channel');
    subscriber.unsubscribe('channel');
    const message = { type: 'TEST_EVENT', value: 42 };

    // Act
    mockRedisInstance.emit('message', 'test:channel', JSON.stringify(message));

    // Assert
    expect(listener).not.toHaveBeenCalled();
  });

  it('should drop messages with wrong type literal', () => {
    // Arrange
    const subscriber = createRedisSubscriber(
      TEST_CHANNEL_DEF,
      'redis://localhost:6379',
    );
    const listener = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockReturnValue(undefined);
    subscriber.subscribe(listener, 'channel');

    // Act
    mockRedisInstance.emit(
      'message',
      'test:channel',
      JSON.stringify({ type: 'WRONG_EVENT', value: 42 }),
    );

    // Assert
    expect(listener).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('should call redis.quit on disconnect', async () => {
    // Arrange
    const subscriber = createRedisSubscriber(
      TEST_CHANNEL_DEF,
      'redis://localhost:6379',
    );

    // Act
    await subscriber.disconnect();

    // Assert
    expect(mockRedisInstance.quit).toHaveBeenCalled();
  });
});
