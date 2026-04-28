import { Type } from 'typebox';
import { beforeEach, describe, expect, vi } from 'vitest';

import {
  type ChannelDefinition,
  EventBusService,
} from '#src/server/shared/services/event-bus.service.js';
import { type MockLogger, createMockLogger } from '#tests/utils/mock-logger.js';

const TEST_CHANNEL: ChannelDefinition<
  ReturnType<typeof Type.Object<{ value: ReturnType<typeof Type.Number> }>>,
  [string]
> = {
  schema: Type.Object({ value: Type.Number() }),
  key: (id: string) => `test:${id}`,
};

describe('EventBusService', () => {
  let logger: MockLogger;
  let bus: EventBusService;

  beforeEach(() => {
    logger = createMockLogger();
    bus = new EventBusService(logger as never);
  });

  describe('publish', (it) => {
    it('is a no-op when no listeners are subscribed', () => {
      // Arrange / Act
      bus.publish(TEST_CHANNEL, { value: 1 }, 'a');

      // Assert
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('delivers messages only to listeners on the matching key', () => {
      // Arrange
      const listenerA = vi.fn();
      const listenerB = vi.fn();
      bus.subscribe(TEST_CHANNEL, listenerA, 'a');
      bus.subscribe(TEST_CHANNEL, listenerB, 'b');

      // Act
      bus.publish(TEST_CHANNEL, { value: 42 }, 'a');

      // Assert
      expect(listenerA).toHaveBeenCalledWith({ value: 42 });
      expect(listenerB).not.toHaveBeenCalled();
    });

    it('invokes every listener subscribed to the same key', () => {
      // Arrange
      const listenerA = vi.fn();
      const listenerB = vi.fn();
      bus.subscribe(TEST_CHANNEL, listenerA, 'a');
      bus.subscribe(TEST_CHANNEL, listenerB, 'a');

      // Act
      bus.publish(TEST_CHANNEL, { value: 1 }, 'a');

      // Assert
      expect(listenerA).toHaveBeenCalledTimes(1);
      expect(listenerB).toHaveBeenCalledTimes(1);
    });

    it('logs and continues when a listener throws', () => {
      // Arrange
      const bad = vi.fn(() => {
        throw new Error('boom');
      });
      const good = vi.fn();
      bus.subscribe(TEST_CHANNEL, bad, 'a');
      bus.subscribe(TEST_CHANNEL, good, 'a');

      // Act
      bus.publish(TEST_CHANNEL, { value: 1 }, 'a');

      // Assert
      expect(good).toHaveBeenCalledWith({ value: 1 });
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), key: 'test:a' }),
        'event-bus listener threw',
      );
    });

    it('passes binary payloads by reference - no serialization', () => {
      // Arrange - the audio path relies on reference-passing for performance.
      const BINARY_CHANNEL: ChannelDefinition<
        ReturnType<typeof Type.Any>,
        [string]
      > = {
        schema: Type.Any(),
        key: (id: string) => `binary:${id}`,
      };
      const buf = Buffer.from([1, 2, 3, 4]);
      const listener = vi.fn();
      bus.subscribe(BINARY_CHANNEL, listener, 'a');

      // Act
      bus.publish(BINARY_CHANNEL, buf, 'a');

      // Assert
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0]?.[0]).toBe(buf);
    });
  });

  describe('subscribe', (it) => {
    it('returns an unsubscribe function that stops further deliveries', () => {
      // Arrange
      const listener = vi.fn();
      const unsubscribe = bus.subscribe(TEST_CHANNEL, listener, 'a');
      bus.publish(TEST_CHANNEL, { value: 1 }, 'a');

      // Act
      unsubscribe();
      bus.publish(TEST_CHANNEL, { value: 2 }, 'a');

      // Assert
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({ value: 1 });
    });

    it('only removes the calling listener when multiple are subscribed', () => {
      // Arrange
      const listenerA = vi.fn();
      const listenerB = vi.fn();
      const unsubA = bus.subscribe(TEST_CHANNEL, listenerA, 'a');
      bus.subscribe(TEST_CHANNEL, listenerB, 'a');

      // Act
      unsubA();
      bus.publish(TEST_CHANNEL, { value: 1 }, 'a');

      // Assert
      expect(listenerA).not.toHaveBeenCalled();
      expect(listenerB).toHaveBeenCalledWith({ value: 1 });
    });

    it('is idempotent when called more than once', () => {
      // Arrange
      const listener = vi.fn();
      const unsubscribe = bus.subscribe(TEST_CHANNEL, listener, 'a');

      // Act
      unsubscribe();
      unsubscribe();

      // Assert
      bus.publish(TEST_CHANNEL, { value: 1 }, 'a');
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
