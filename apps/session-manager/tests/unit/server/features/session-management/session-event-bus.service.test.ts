import { beforeEach, describe, expect, vi } from 'vitest';

import { DeviceSessionEventType } from '@scribear/session-manager-schema';

import { SessionEventBusService } from '#src/server/features/session-management/session-event-bus.service.js';

const TEST_DEVICE_ID = 'test-device-id';
const TEST_EVENT = {
  eventId: 1,
  eventType: DeviceSessionEventType.START_SESSION,
  sessionId: 'test-session-id',
  timestampUnixMs: Date.now(),
};

describe('SessionEventBusService', () => {
  let bus: SessionEventBusService;

  beforeEach(() => {
    bus = new SessionEventBusService();
  });

  describe('emit', (it) => {
    it('calls registered listener with the event', () => {
      // Arrange
      const listener = vi.fn();
      bus.addListener(TEST_DEVICE_ID, listener);

      // Act
      bus.emit(TEST_DEVICE_ID, TEST_EVENT);

      // Assert
      expect(listener).toHaveBeenCalledExactlyOnceWith(TEST_EVENT);
    });

    it('calls all listeners registered for the device', () => {
      // Arrange
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      bus.addListener(TEST_DEVICE_ID, listener1);
      bus.addListener(TEST_DEVICE_ID, listener2);

      // Act
      bus.emit(TEST_DEVICE_ID, TEST_EVENT);

      // Assert
      expect(listener1).toHaveBeenCalledExactlyOnceWith(TEST_EVENT);
      expect(listener2).toHaveBeenCalledExactlyOnceWith(TEST_EVENT);
    });

    it('does not call listeners registered for a different device', () => {
      // Arrange
      const listener = vi.fn();
      bus.addListener('other-device-id', listener);

      // Act
      bus.emit(TEST_DEVICE_ID, TEST_EVENT);

      // Assert
      expect(listener).not.toHaveBeenCalled();
    });

    it('does nothing when no listeners are registered', () => {
      // Arrange Act / Assert
      expect(() => bus.emit(TEST_DEVICE_ID, TEST_EVENT)).not.toThrow();
    });
  });

  describe('removeListener', (it) => {
    it('stops calling listener after it is removed', () => {
      // Arrange
      const listener = vi.fn();
      bus.addListener(TEST_DEVICE_ID, listener);
      bus.removeListener(TEST_DEVICE_ID, listener);

      // Act
      bus.emit(TEST_DEVICE_ID, TEST_EVENT);

      // Assert
      expect(listener).not.toHaveBeenCalled();
    });

    it('does not affect other listeners when one is removed', () => {
      // Arrange
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      bus.addListener(TEST_DEVICE_ID, listener1);
      bus.addListener(TEST_DEVICE_ID, listener2);
      bus.removeListener(TEST_DEVICE_ID, listener1);

      // Act
      bus.emit(TEST_DEVICE_ID, TEST_EVENT);

      // Assert
      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalledExactlyOnceWith(TEST_EVENT);
    });

    it('does nothing when removing a listener that was never added', () => {
      // Arrange / Act / Assert
      expect(() => bus.removeListener(TEST_DEVICE_ID, vi.fn())).not.toThrow();
    });
  });
});
