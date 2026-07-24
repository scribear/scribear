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
  disconnect: ReturnType<typeof vi.fn>;
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
    disconnect: vi.fn<() => void>(),
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

  it('should register an error listener so a connection error does not crash the process', () => {
    // A bare ioredis client emitting `error` with no listener throws and takes
    // the process down. The factory owns its client, so it must listen itself -
    // a telemetry backplane it cannot reach should cost events, not the server.
    //
    // Arrange
    const warnSpy = vi.spyOn(console, 'warn').mockReturnValue(undefined);
    createRedisSubscriber(TEST_CHANNEL_DEF, 'redis://localhost:6379');

    // Act + Assert: emitting `error` must not throw (a listener is attached).
    expect(() =>
      mockRedisInstance.emit('error', new Error('WRONGPASS')),
    ).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('WRONGPASS'),
    );
  });

  it('should swallow a rejected subscribe rather than leak an unhandled rejection', async () => {
    // `redis.subscribe` rejects when auth fails or the connection drops before
    // it lands. Discarded with `void`, that reject is an unhandled rejection,
    // which under Node's default crashes the process - black-holing admin login.
    //
    // Arrange
    mockRedisInstance.subscribe.mockRejectedValueOnce(new Error('WRONGPASS'));
    const warnSpy = vi.spyOn(console, 'warn').mockReturnValue(undefined);
    const subscriber = createRedisSubscriber(
      TEST_CHANNEL_DEF,
      'redis://localhost:6379',
    );

    // Act: the synchronous call must not throw, and the pending rejection must
    // be caught on the next microtask rather than surfacing as unhandled.
    subscriber.subscribe(vi.fn(), 'channel');
    await Promise.resolve();

    // Assert
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to subscribe'),
    );
  });

  it('should call redis.disconnect on disconnect, not the graceful quit', async () => {
    // `quit` is an ordinary command: if the connection never established, it
    // queues behind the `subscribe` this class always issues and waits on a
    // reconnect loop that retries forever by default - hanging shutdown in
    // exactly the case a subscriber is most likely to be torn down in.
    //
    // Arrange
    const subscriber = createRedisSubscriber(
      TEST_CHANNEL_DEF,
      'redis://localhost:6379',
    );

    // Act
    await subscriber.disconnect();

    // Assert
    expect(mockRedisInstance.disconnect).toHaveBeenCalled();
  });
});
