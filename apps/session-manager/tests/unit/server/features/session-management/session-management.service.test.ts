import { type Mock, afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { DeviceSessionEventType } from '@scribear/session-manager-schema';

import { SessionManagementService } from '#src/server/features/session-management/session-management.service.js';

const TEST_DEVICE_ID = 'test-device-id';
const TEST_SESSION_ID = 'test-session-id';
const TEST_START_EVENT_ID = 1;
const TEST_PROVIDER_KEY = 'deepgram';
const TEST_PROVIDER_CONFIG = { apiKey: 'sk-test' };
const FAKE_NOW = new Date('2025-01-01T00:00:00Z');

describe('SessionManagementService', () => {
  let mockRepository: {
    deviceExists: Mock;
    createSession: Mock;
    getNextSessionEvent: Mock;
  };
  let mockEventBus: {
    addListener: Mock;
    removeListener: Mock;
    emit: Mock;
  };
  let service: SessionManagementService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FAKE_NOW);

    mockRepository = {
      deviceExists: vi.fn(),
      createSession: vi.fn(),
      getNextSessionEvent: vi.fn(),
    };
    mockEventBus = {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      emit: vi.fn(),
    };

    service = new SessionManagementService(
      mockRepository as never,
      mockEventBus as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createOnDemandSession', (it) => {
    it('returns INVALID_END_TIME when endTimeUnixMs is in the past', async () => {
      // Act
      const result = await service.createOnDemandSession(
        TEST_DEVICE_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        FAKE_NOW.getTime() - 1,
      );

      // Assert
      expect(result).toEqual({ error: 'INVALID_END_TIME' });
      expect(mockRepository.deviceExists).not.toHaveBeenCalled();
    });

    it('returns INVALID_END_TIME when endTimeUnixMs equals now', async () => {
      // Act
      const result = await service.createOnDemandSession(
        TEST_DEVICE_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        FAKE_NOW.getTime(),
      );

      // Assert
      expect(result).toEqual({ error: 'INVALID_END_TIME' });
    });

    it('returns INVALID_SOURCE_DEVICE when device does not exist', async () => {
      // Arrange
      mockRepository.deviceExists.mockResolvedValue(false);
      const futureMs = FAKE_NOW.getTime() + 60_000;

      // Act
      const result = await service.createOnDemandSession(
        TEST_DEVICE_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        futureMs,
      );

      // Assert
      expect(result).toEqual({ error: 'INVALID_SOURCE_DEVICE' });
      expect(mockRepository.createSession).not.toHaveBeenCalled();
    });

    it('creates session and returns sessionId on success', async () => {
      // Arrange
      mockRepository.deviceExists.mockResolvedValue(true);
      mockRepository.createSession.mockResolvedValue({
        session: { id: TEST_SESSION_ID },
        startEvent: { id: TEST_START_EVENT_ID },
        endEvent: { id: 2 },
      });
      const futureMs = FAKE_NOW.getTime() + 60_000;

      // Act
      const result = await service.createOnDemandSession(
        TEST_DEVICE_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        futureMs,
      );

      // Assert
      expect(mockRepository.createSession).toHaveBeenCalledExactlyOnceWith(
        TEST_DEVICE_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        FAKE_NOW,
        new Date(futureMs),
      );
      expect(result).toEqual({ sessionId: TEST_SESSION_ID });
    });

    it('emits START_SESSION event on the bus after creating session', async () => {
      // Arrange
      mockRepository.deviceExists.mockResolvedValue(true);
      mockRepository.createSession.mockResolvedValue({
        session: { id: TEST_SESSION_ID },
        startEvent: { id: TEST_START_EVENT_ID },
        endEvent: { id: 2 },
      });

      // Act
      await service.createOnDemandSession(
        TEST_DEVICE_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        FAKE_NOW.getTime() + 60_000,
      );

      // Assert
      expect(mockEventBus.emit).toHaveBeenCalledExactlyOnceWith(TEST_DEVICE_ID, {
        eventId: TEST_START_EVENT_ID,
        eventType: DeviceSessionEventType.START_SESSION,
        sessionId: TEST_SESSION_ID,
        timestampUnixMs: FAKE_NOW.getTime(),
      });
    });
  });

  describe('getDeviceSessionEvent', (it) => {
    it('resolves immediately when DB returns a past event', async () => {
      // Arrange
      const pastTimestamp = new Date(FAKE_NOW.getTime() - 1000);
      const dbEvent = {
        id: 1,
        event_type: 'START_SESSION',
        session_id: TEST_SESSION_ID,
        timestamp: pastTimestamp,
      };
      mockRepository.getNextSessionEvent.mockResolvedValue(dbEvent);

      // Act
      const result = await service.getDeviceSessionEvent(TEST_DEVICE_ID, undefined);

      // Assert
      expect(result).toEqual({
        eventId: 1,
        eventType: DeviceSessionEventType.START_SESSION,
        sessionId: TEST_SESSION_ID,
        timestampUnixMs: pastTimestamp.getTime(),
      });
      expect(mockEventBus.addListener).toHaveBeenCalled();
      expect(mockEventBus.removeListener).toHaveBeenCalled();
    });

    it('resolves with bus event when bus emits before DB resolves', async () => {
      // Arrange
      const busEvent = {
        eventId: 1,
        eventType: DeviceSessionEventType.START_SESSION,
        sessionId: TEST_SESSION_ID,
        timestampUnixMs: FAKE_NOW.getTime(),
      };

      let capturedListener: ((event: typeof busEvent) => void) | undefined;
      mockEventBus.addListener.mockImplementation(
        (_deviceId: string, listener: typeof capturedListener) => {
          capturedListener = listener;
        },
      );

      // DB resolves with no event
      mockRepository.getNextSessionEvent.mockResolvedValue(undefined);

      // Act
      const resultPromise = service.getDeviceSessionEvent(TEST_DEVICE_ID, undefined);

      // Listener is registered synchronously; emit immediately
      capturedListener!(busEvent);

      const result = await resultPromise;

      // Assert
      expect(result).toEqual(busEvent);
    });

    it('resolves with null after poll timeout when no DB event and no bus event', async () => {
      // Arrange
      mockRepository.getNextSessionEvent.mockResolvedValue(undefined);

      // Act
      const resultPromise = service.getDeviceSessionEvent(TEST_DEVICE_ID, undefined);

      // Fast-forward past the 25s poll timeout
      await Promise.resolve();
      vi.advanceTimersByTime(25_000);

      const result = await resultPromise;

      // Assert
      expect(result).toBeNull();
    });

    it('passes prevEventId to repository', async () => {
      // Arrange
      mockRepository.getNextSessionEvent.mockResolvedValue(undefined);

      const resultPromise = service.getDeviceSessionEvent(TEST_DEVICE_ID, 5);

      await Promise.resolve();
      vi.advanceTimersByTime(25_000);
      await resultPromise;

      // Assert
      expect(mockRepository.getNextSessionEvent).toHaveBeenCalledExactlyOnceWith(
        TEST_DEVICE_ID,
        5,
        expect.any(Date),
      );
    });

    it('passes null as afterEventId when prevEventId is undefined', async () => {
      // Arrange
      mockRepository.getNextSessionEvent.mockResolvedValue(undefined);

      const resultPromise = service.getDeviceSessionEvent(TEST_DEVICE_ID, undefined);

      await Promise.resolve();
      vi.advanceTimersByTime(25_000);
      await resultPromise;

      // Assert
      expect(mockRepository.getNextSessionEvent).toHaveBeenCalledExactlyOnceWith(
        TEST_DEVICE_ID,
        null,
        expect.any(Date),
      );
    });

    it('resolves with future event after its delay', async () => {
      // Arrange
      const delayMs = 5_000;
      const futureTimestamp = new Date(FAKE_NOW.getTime() + delayMs);
      const dbEvent = {
        id: 3,
        event_type: 'END_SESSION',
        session_id: TEST_SESSION_ID,
        timestamp: futureTimestamp,
      };
      mockRepository.getNextSessionEvent.mockResolvedValue(dbEvent);

      // Act
      const resultPromise = service.getDeviceSessionEvent(TEST_DEVICE_ID, undefined);

      await Promise.resolve();
      vi.advanceTimersByTime(delayMs);

      const result = await resultPromise;

      // Assert
      expect(result).toEqual({
        eventId: 3,
        eventType: DeviceSessionEventType.END_SESSION,
        sessionId: TEST_SESSION_ID,
        timestampUnixMs: futureTimestamp.getTime(),
      });
    });
  });
});
