import { describe, expect, vi } from 'vitest';

import type {
  FLEET_EVENT_SCHEMA,
  FleetEvent,
  RedisSubscriber,
} from '@scribear/scribear-redis';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { FleetEventsService } from '#src/server/shared/services/fleet-events.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

const SESSION_EVENT: FleetEvent = {
  t: 'session',
  sessionUid: '00000000-0000-0000-0000-0000000000ab',
  transcriptionServiceConnected: true,
  sourceDeviceConnected: false,
  at: 1_800_000_000_000,
};

/**
 * Stand-in for `RedisSubscriber`. `subscribe` records the one listener
 * `FleetEventsService` registers with it and exposes `emit` so a test can
 * play a message through it, the same shape ioredis's `message` event would.
 */
class FakeSubscriber {
  listener: ((event: FleetEvent) => void) | null = null;
  disconnect = vi.fn(() => Promise.resolve());

  subscribe = vi.fn((listener: (event: FleetEvent) => void) => {
    this.listener = listener;
  });

  emit(event: FleetEvent): void {
    this.listener?.(event);
  }
}

function buildHarness() {
  const subscriber = new FakeSubscriber();
  const logger = createMockLogger();
  const service = new FleetEventsService(
    subscriber as unknown as RedisSubscriber<typeof FLEET_EVENT_SCHEMA, []>,
    logger as unknown as AppDependencies['logger'],
  );
  return { service, subscriber, logger };
}

describe('FleetEventsService', () => {
  describe('enabled', (it) => {
    it('is disabled when no subscriber was built (REDIS_URL unset)', () => {
      const service = new FleetEventsService(
        null,
        createMockLogger() as unknown as AppDependencies['logger'],
      );

      expect(service.enabled).toBe(false);
    });

    it('is enabled when a subscriber was built', () => {
      const { service } = buildHarness();

      expect(service.enabled).toBe(true);
    });

    it('subscribes once, immediately, rather than waiting for a listener', () => {
      const { subscriber } = buildHarness();

      expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe('fan-out', (it) => {
    it('delivers a message to every registered listener', () => {
      const { subscriber } = buildHarness();
      const first = vi.fn();
      const second = vi.fn();
      const svc = new FleetEventsService(
        subscriber as unknown as RedisSubscriber<typeof FLEET_EVENT_SCHEMA, []>,
        createMockLogger() as unknown as AppDependencies['logger'],
      );
      svc.addListener(first);
      svc.addListener(second);

      subscriber.emit(SESSION_EVENT);

      expect(first).toHaveBeenCalledWith(SESSION_EVENT);
      expect(second).toHaveBeenCalledWith(SESSION_EVENT);
    });

    it('stops delivering to a listener once unregistered', () => {
      const { subscriber, service } = buildHarness();
      const listener = vi.fn();
      const unregister = service.addListener(listener);

      unregister();
      subscriber.emit(SESSION_EVENT);

      expect(listener).not.toHaveBeenCalled();
    });

    it('does not let one listener throwing stop the others', () => {
      const { subscriber, service, logger } = buildHarness();
      const throwing = vi.fn(() => {
        throw new Error('boom');
      });
      const fine = vi.fn();
      service.addListener(throwing);
      service.addListener(fine);

      subscriber.emit(SESSION_EVENT);

      expect(fine).toHaveBeenCalledWith(SESSION_EVENT);
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('delivers nothing when disabled, since there is no subscription', () => {
      const service = new FleetEventsService(
        null,
        createMockLogger() as unknown as AppDependencies['logger'],
      );
      const listener = vi.fn();
      service.addListener(listener);

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('close', (it) => {
    it('disconnects the subscriber and clears listeners', async () => {
      const { subscriber, service } = buildHarness();
      const listener = vi.fn();
      service.addListener(listener);

      await service.close();
      subscriber.emit(SESSION_EVENT);

      expect(subscriber.disconnect).toHaveBeenCalledTimes(1);
      expect(listener).not.toHaveBeenCalled();
    });

    it('is a no-op when disabled', async () => {
      const service = new FleetEventsService(
        null,
        createMockLogger() as unknown as AppDependencies['logger'],
      );

      await expect(service.close()).resolves.toBeUndefined();
    });
  });
});
