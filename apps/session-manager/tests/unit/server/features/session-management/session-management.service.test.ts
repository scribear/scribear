import { type Mock, afterEach, beforeEach, describe, expect, vi } from 'vitest';

import {
  DeviceSessionEventType,
  SessionScope,
} from '@scribear/session-manager-schema';

import { SessionManagementService } from '#src/server/features/session-management/session-management.service.js';

const TEST_DEVICE_ID = 'test-device-id';
const TEST_SESSION_ID = 'test-session-id';
const TEST_START_EVENT_ID = 1;
const TEST_PROVIDER_KEY = 'whisper';
const TEST_PROVIDER_CONFIG = { apiKey: 'sk-test' };
const FAKE_NOW = new Date('2025-01-01T00:00:00Z');
const TEST_JOIN_CODE = 'ABCD1234';
const TEST_SESSION_TOKEN = 'signed.jwt.token';

describe('SessionManagementService', () => {
  let mockRepository: {
    deviceExists: Mock;
    createSession: Mock;
    getNextSessionEvent: Mock;
    findActiveSessionByJoinCode: Mock;
  };
  let mockEventBus: {
    addListener: Mock;
    removeListener: Mock;
    emit: Mock;
  };
  let mockJwtService: {
    signSessionToken: Mock;
  };
  let service: SessionManagementService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FAKE_NOW);

    mockRepository = {
      deviceExists: vi.fn(),
      createSession: vi.fn(),
      getNextSessionEvent: vi.fn(),
      findActiveSessionByJoinCode: vi.fn(),
    };
    mockEventBus = {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      emit: vi.fn(),
    };
    mockJwtService = {
      signSessionToken: vi.fn().mockReturnValue(TEST_SESSION_TOKEN),
    };

    service = new SessionManagementService(
      mockRepository as never,
      mockEventBus as never,
      mockJwtService as never,
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
        false,
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
        false,
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
        false,
      );

      // Assert
      expect(result).toEqual({ error: 'INVALID_SOURCE_DEVICE' });
      expect(mockRepository.createSession).not.toHaveBeenCalled();
    });

    it('creates session and returns sessionId with null joinCode when enableJoinCode=false', async () => {
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
        false,
      );

      // Assert
      expect(mockRepository.createSession).toHaveBeenCalledExactlyOnceWith(
        TEST_DEVICE_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        FAKE_NOW,
        new Date(futureMs),
        null,
      );
      expect(result).toEqual({ sessionId: TEST_SESSION_ID, joinCode: null });
    });

    it('creates session and returns a joinCode when enableJoinCode=true', async () => {
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
        true,
      );

      // Assert
      expect(result).toMatchObject({ sessionId: TEST_SESSION_ID });
      expect('joinCode' in result && typeof result.joinCode).toBe('string');
      // Join code is 8 uppercase alphanumeric chars
      expect(result).toMatchObject({
        joinCode: expect.stringMatching(/^[A-Z0-9]{8}$/),
      });

      // The join code passed to repository should match what was returned
      const passedJoinCode = mockRepository.createSession.mock.calls[0]?.[5];
      expect(passedJoinCode).toMatch(/^[A-Z0-9]{8}$/);
      expect(passedJoinCode).toBe(
        (result as { sessionId: string; joinCode: string }).joinCode,
      );
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
        false,
      );

      // Assert
      expect(mockEventBus.emit).toHaveBeenCalledExactlyOnceWith(
        TEST_DEVICE_ID,
        {
          eventId: TEST_START_EVENT_ID,
          eventType: DeviceSessionEventType.START_SESSION,
          sessionId: TEST_SESSION_ID,
          timestampUnixMs: FAKE_NOW.getTime(),
        },
      );
    });
  });

  describe('authenticateWithJoinCode', (it) => {
    it('returns INVALID_JOIN_CODE when no active session matches', async () => {
      // Arrange
      mockRepository.findActiveSessionByJoinCode.mockResolvedValue(undefined);

      // Act
      const result = await service.authenticateWithJoinCode(TEST_JOIN_CODE);

      // Assert
      expect(result).toEqual({ error: 'INVALID_JOIN_CODE' });
      expect(mockJwtService.signSessionToken).not.toHaveBeenCalled();
    });

    it('returns a sessionToken signed with sessionId and receive_transcriptions scope', async () => {
      // Arrange
      mockRepository.findActiveSessionByJoinCode.mockResolvedValue({
        id: TEST_SESSION_ID,
      });

      // Act
      const result = await service.authenticateWithJoinCode(TEST_JOIN_CODE);

      // Assert
      expect(mockJwtService.signSessionToken).toHaveBeenCalledExactlyOnceWith({
        sessionId: TEST_SESSION_ID,
        scopes: [SessionScope.RECEIVE_TRANSCRIPTIONS],
      });
      expect(result).toEqual({ sessionToken: TEST_SESSION_TOKEN });
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
      const result = await service.getDeviceSessionEvent(
        TEST_DEVICE_ID,
        undefined,
      );

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
      const resultPromise = service.getDeviceSessionEvent(
        TEST_DEVICE_ID,
        undefined,
      );

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
      const resultPromise = service.getDeviceSessionEvent(
        TEST_DEVICE_ID,
        undefined,
      );

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
      expect(
        mockRepository.getNextSessionEvent,
      ).toHaveBeenCalledExactlyOnceWith(TEST_DEVICE_ID, 5, expect.any(Date));
    });

    it('passes null as afterEventId when prevEventId is undefined', async () => {
      // Arrange
      mockRepository.getNextSessionEvent.mockResolvedValue(undefined);

      const resultPromise = service.getDeviceSessionEvent(
        TEST_DEVICE_ID,
        undefined,
      );

      await Promise.resolve();
      vi.advanceTimersByTime(25_000);
      await resultPromise;

      // Assert
      expect(
        mockRepository.getNextSessionEvent,
      ).toHaveBeenCalledExactlyOnceWith(TEST_DEVICE_ID, null, expect.any(Date));
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
      const resultPromise = service.getDeviceSessionEvent(
        TEST_DEVICE_ID,
        undefined,
      );

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
