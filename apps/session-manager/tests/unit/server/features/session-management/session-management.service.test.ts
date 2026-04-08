import { type Mock, afterEach, beforeEach, describe, expect, vi } from 'vitest';

import {
  DeviceSessionEventType,
  SessionChannelEventType,
  SessionTokenScope,
} from '@scribear/session-manager-schema';

import { SessionManagementService } from '#src/server/features/session-management/session-management.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

const TEST_DEVICE_ID = 'test-device-id';
const TEST_SESSION_ID = 'test-session-id';
const TEST_START_EVENT_ID = 1;
const TEST_PROVIDER_KEY = 'whisper';
const TEST_PROVIDER_CONFIG = { apiKey: 'sk-test' };
const FAKE_NOW = new Date('2025-01-01T00:00:00Z');
const TEST_END_TIME = new Date('2025-01-01T01:00:00Z');
const TEST_JOIN_CODE = 'ABCD1234';
const TEST_SESSION_TOKEN = 'signed.jwt.token';
const TEST_REFRESH_TOKEN_ID = 'refresh-token-id';
const TEST_SECRET_HASH = 'hashed-secret';

describe('SessionManagementService', () => {
  let mockRepository: {
    deviceExists: Mock;
    createSession: Mock;
    getNextSessionEvent: Mock;
    findActiveSessionBySourceDevice: Mock;
    findSessionById: Mock;
    endSession: Mock;
  };
  let mockRefreshTokenRepository: {
    create: Mock;
    findById: Mock;
    deleteBySessionId: Mock;
  };
  let mockJoinCodeRepository: {
    create: Mock;
    findActiveSessionByJoinCode: Mock;
    getLatestValidCode: Mock;
    getOrRotateJoinCode: Mock;
    deleteBySessionId: Mock;
  };
  let mockEventBus: {
    addListener: Mock;
    removeListener: Mock;
    emit: Mock;
  };
  let mockJwtService: {
    signSessionToken: Mock;
  };
  let mockHashService: {
    hash: Mock;
    verify: Mock;
  };
  let mockRedisPublisher: {
    publish: Mock;
    disconnect: Mock;
  };
  let service: SessionManagementService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FAKE_NOW);

    mockRepository = {
      deviceExists: vi.fn(),
      createSession: vi.fn(),
      getNextSessionEvent: vi.fn(),
      findActiveSessionBySourceDevice: vi.fn(),
      findSessionById: vi.fn(),
      endSession: vi.fn(),
    };
    mockRefreshTokenRepository = {
      create: vi.fn().mockResolvedValue({ id: TEST_REFRESH_TOKEN_ID }),
      findById: vi.fn(),
      deleteBySessionId: vi.fn(),
    };
    mockJoinCodeRepository = {
      create: vi.fn().mockResolvedValue({
        id: 'join-code-id',
        code: TEST_JOIN_CODE,
        expires_at: new Date(FAKE_NOW.getTime() + 5 * 60 * 1000),
      }),
      findActiveSessionByJoinCode: vi.fn(),
      getLatestValidCode: vi.fn(),
      getOrRotateJoinCode: vi.fn(),
      deleteBySessionId: vi.fn(),
    };
    mockEventBus = {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      emit: vi.fn(),
    };
    mockJwtService = {
      signSessionToken: vi.fn().mockReturnValue(TEST_SESSION_TOKEN),
    };
    mockHashService = {
      hash: vi.fn().mockResolvedValue(TEST_SECRET_HASH),
      verify: vi.fn(),
    };
    mockRedisPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };

    service = new SessionManagementService(
      createMockLogger() as never,
      mockRepository as never,
      mockRefreshTokenRepository as never,
      mockJoinCodeRepository as never,
      mockEventBus as never,
      mockJwtService as never,
      mockHashService as never,
      mockRedisPublisher as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createOnDemandSession', (it) => {
    it('returns null when endTimeUnixMs is in the past', async () => {
      // Act
      const result = await service.createOnDemandSession(
        TEST_DEVICE_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        FAKE_NOW.getTime() - 1,
        false,
        undefined,
        undefined,
      );

      // Assert
      expect(result).toBeNull();
      expect(mockRepository.deviceExists).not.toHaveBeenCalled();
    });

    it('returns null when endTimeUnixMs equals now', async () => {
      // Act
      const result = await service.createOnDemandSession(
        TEST_DEVICE_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        FAKE_NOW.getTime(),
        false,
        undefined,
        undefined,
      );

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when device does not exist', async () => {
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
        undefined,
        undefined,
      );

      // Assert
      expect(result).toBeNull();
      expect(mockRepository.createSession).not.toHaveBeenCalled();
    });

    it('creates session without join code when enableJoinCode=false', async () => {
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
        undefined,
        undefined,
      );

      // Assert
      expect(mockRepository.createSession).toHaveBeenCalledExactlyOnceWith(
        TEST_DEVICE_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        FAKE_NOW,
        new Date(futureMs),
        null,
        null,
      );
      expect(mockJoinCodeRepository.create).not.toHaveBeenCalled();
      expect(result).toEqual({ sessionId: TEST_SESSION_ID });
    });

    it('creates session with join code when enableJoinCode=true', async () => {
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
        undefined,
        undefined,
      );

      // Assert
      expect(mockRepository.createSession).toHaveBeenCalledExactlyOnceWith(
        TEST_DEVICE_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        FAKE_NOW,
        new Date(futureMs),
        8,
        true,
      );
      expect(mockJoinCodeRepository.create).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        expect.stringMatching(/^[A-Z0-9]{8}$/),
        FAKE_NOW,
        new Date(FAKE_NOW.getTime() + 5 * 60 * 1000),
      );
      expect(result).toEqual({ sessionId: TEST_SESSION_ID });
    });

    it('uses custom joinCodeLength when provided', async () => {
      // Arrange
      mockRepository.deviceExists.mockResolvedValue(true);
      mockRepository.createSession.mockResolvedValue({
        session: { id: TEST_SESSION_ID },
        startEvent: { id: TEST_START_EVENT_ID },
        endEvent: { id: 2 },
      });
      const futureMs = FAKE_NOW.getTime() + 60_000;

      // Act
      await service.createOnDemandSession(
        TEST_DEVICE_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        futureMs,
        true,
        6,
        false,
      );

      // Assert
      expect(mockRepository.createSession).toHaveBeenCalledWith(
        TEST_DEVICE_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        FAKE_NOW,
        new Date(futureMs),
        6,
        false,
      );
      expect(mockJoinCodeRepository.create).toHaveBeenCalledWith(
        TEST_SESSION_ID,
        expect.stringMatching(/^[A-Z0-9]{6}$/),
        FAKE_NOW,
        expect.any(Date),
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
        undefined,
        undefined,
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

    it('creates indefinite session when endTimeUnixMs is undefined', async () => {
      // Arrange
      mockRepository.deviceExists.mockResolvedValue(true);
      mockRepository.createSession.mockResolvedValue({
        session: { id: TEST_SESSION_ID },
        startEvent: { id: TEST_START_EVENT_ID },
        endEvent: null,
      });

      // Act
      const result = await service.createOnDemandSession(
        TEST_DEVICE_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        undefined,
        false,
        undefined,
        undefined,
      );

      // Assert
      expect(mockRepository.createSession).toHaveBeenCalledExactlyOnceWith(
        TEST_DEVICE_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        FAKE_NOW,
        null,
        null,
        null,
      );
      expect(result).toEqual({ sessionId: TEST_SESSION_ID });
    });
  });

  describe('authenticateWithJoinCode', (it) => {
    it('returns null when no active session matches', async () => {
      // Arrange
      mockJoinCodeRepository.findActiveSessionByJoinCode.mockResolvedValue(
        undefined,
      );

      // Act
      const result = await service.authenticateWithJoinCode(TEST_JOIN_CODE);

      // Assert
      expect(result).toBeNull();
      expect(mockJwtService.signSessionToken).not.toHaveBeenCalled();
    });

    it('returns sessionToken and sessionRefreshToken with RECEIVE_TRANSCRIPTIONS scope and 5-min expiry', async () => {
      // Arrange
      mockJoinCodeRepository.findActiveSessionByJoinCode.mockResolvedValue({
        id: TEST_SESSION_ID,
        end_time: TEST_END_TIME,
      });

      // Act
      const result = await service.authenticateWithJoinCode(TEST_JOIN_CODE);

      // Assert
      expect(mockJwtService.signSessionToken).toHaveBeenCalledExactlyOnceWith({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_REFRESH_TOKEN_ID,
        scopes: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        exp: Math.floor(FAKE_NOW.getTime() / 1000) + 300,
      });
      expect(result).toEqual({
        sessionToken: TEST_SESSION_TOKEN,
        sessionRefreshToken: expect.stringContaining(TEST_REFRESH_TOKEN_ID),
      });
    });

    it('creates a refresh token with join_code auth method', async () => {
      // Arrange
      mockJoinCodeRepository.findActiveSessionByJoinCode.mockResolvedValue({
        id: TEST_SESSION_ID,
        end_time: TEST_END_TIME,
      });

      // Act
      await service.authenticateWithJoinCode(TEST_JOIN_CODE);

      // Assert
      expect(mockRefreshTokenRepository.create).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        'join_code',
        null,
        TEST_SECRET_HASH,
      );
    });

    it('authenticates indefinite sessions (null end_time)', async () => {
      // Arrange
      mockJoinCodeRepository.findActiveSessionByJoinCode.mockResolvedValue({
        id: TEST_SESSION_ID,
        end_time: null,
      });

      // Act
      const result = await service.authenticateWithJoinCode(TEST_JOIN_CODE);

      // Assert
      expect(result).not.toBeNull();
      expect(mockJwtService.signSessionToken).toHaveBeenCalled();
    });
  });

  describe('authenticateSourceDevice', (it) => {
    it('returns null when no active session matches', async () => {
      // Arrange
      mockRepository.findActiveSessionBySourceDevice.mockResolvedValue(
        undefined,
      );

      // Act
      const result = await service.authenticateSourceDevice(
        TEST_DEVICE_ID,
        TEST_SESSION_ID,
      );

      // Assert
      expect(result).toBeNull();
      expect(mockJwtService.signSessionToken).not.toHaveBeenCalled();
    });

    it('queries the repository with the correct deviceId and sessionId', async () => {
      // Arrange
      mockRepository.findActiveSessionBySourceDevice.mockResolvedValue(
        undefined,
      );

      // Act
      await service.authenticateSourceDevice(TEST_DEVICE_ID, TEST_SESSION_ID);

      // Assert
      expect(
        mockRepository.findActiveSessionBySourceDevice,
      ).toHaveBeenCalledExactlyOnceWith(TEST_DEVICE_ID, TEST_SESSION_ID);
    });

    it('returns sessionToken and sessionRefreshToken with both scopes and 5-min expiry', async () => {
      // Arrange
      mockRepository.findActiveSessionBySourceDevice.mockResolvedValue({
        id: TEST_SESSION_ID,
        end_time: TEST_END_TIME,
        transcription_provider_key: TEST_PROVIDER_KEY,
        transcription_provider_config: TEST_PROVIDER_CONFIG,
      });

      // Act
      const result = await service.authenticateSourceDevice(
        TEST_DEVICE_ID,
        TEST_SESSION_ID,
      );

      // Assert
      expect(mockJwtService.signSessionToken).toHaveBeenCalledExactlyOnceWith({
        sessionId: TEST_SESSION_ID,
        clientId: TEST_REFRESH_TOKEN_ID,
        scopes: [
          SessionTokenScope.RECEIVE_TRANSCRIPTIONS,
          SessionTokenScope.SEND_AUDIO,
        ],
        exp: Math.floor(FAKE_NOW.getTime() / 1000) + 300,
      });
      expect(result).toMatchObject({
        sessionToken: TEST_SESSION_TOKEN,
        sessionRefreshToken: expect.stringContaining(TEST_REFRESH_TOKEN_ID),
      });
    });

    it('creates a refresh token with source_device auth method', async () => {
      // Arrange
      mockRepository.findActiveSessionBySourceDevice.mockResolvedValue({
        id: TEST_SESSION_ID,
        end_time: TEST_END_TIME,
        transcription_provider_key: TEST_PROVIDER_KEY,
        transcription_provider_config: TEST_PROVIDER_CONFIG,
      });

      // Act
      await service.authenticateSourceDevice(TEST_DEVICE_ID, TEST_SESSION_ID);

      // Assert
      expect(mockRefreshTokenRepository.create).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        [
          SessionTokenScope.RECEIVE_TRANSCRIPTIONS,
          SessionTokenScope.SEND_AUDIO,
        ],
        'source_device',
        null,
        TEST_SECRET_HASH,
      );
    });
  });

  describe('refreshSessionToken', (it) => {
    it('returns null for invalid token format', async () => {
      // Act
      const result = await service.refreshSessionToken('no-separator');

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when refresh token not found in DB', async () => {
      // Arrange
      mockRefreshTokenRepository.findById.mockResolvedValue(undefined);

      // Act
      const result = await service.refreshSessionToken('some-id:some-secret');

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when secret does not match', async () => {
      // Arrange
      mockRefreshTokenRepository.findById.mockResolvedValue({
        id: 'some-id',
        session_id: TEST_SESSION_ID,
        scope: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        auth_method: 'join_code',
        expiry: null,
        secret_hash: TEST_SECRET_HASH,
      });
      mockHashService.verify.mockResolvedValue(false);

      // Act
      const result = await service.refreshSessionToken('some-id:wrong-secret');

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when session has ended', async () => {
      // Arrange
      mockRefreshTokenRepository.findById.mockResolvedValue({
        id: 'some-id',
        session_id: TEST_SESSION_ID,
        scope: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        auth_method: 'join_code',
        expiry: null,
        secret_hash: TEST_SECRET_HASH,
      });
      mockHashService.verify.mockResolvedValue(true);
      mockRepository.findSessionById.mockResolvedValue({
        id: TEST_SESSION_ID,
        start_time: new Date(FAKE_NOW.getTime() - 60_000),
        end_time: new Date(FAKE_NOW.getTime() - 1000),
      });

      // Act
      const result = await service.refreshSessionToken('some-id:valid-secret');

      // Assert
      expect(result).toBeNull();
    });

    it('returns new session token when valid', async () => {
      // Arrange
      mockRefreshTokenRepository.findById.mockResolvedValue({
        id: 'some-id',
        session_id: TEST_SESSION_ID,
        scope: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        auth_method: 'join_code',
        expiry: null,
        secret_hash: TEST_SECRET_HASH,
      });
      mockHashService.verify.mockResolvedValue(true);
      mockRepository.findSessionById.mockResolvedValue({
        id: TEST_SESSION_ID,
        start_time: new Date(FAKE_NOW.getTime() - 60_000),
        end_time: TEST_END_TIME,
      });

      // Act
      const result = await service.refreshSessionToken('some-id:valid-secret');

      // Assert
      expect(result).toEqual({ sessionToken: TEST_SESSION_TOKEN });
      expect(mockJwtService.signSessionToken).toHaveBeenCalledExactlyOnceWith({
        sessionId: TEST_SESSION_ID,
        clientId: 'some-id',
        scopes: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        exp: Math.floor(FAKE_NOW.getTime() / 1000) + 300,
      });
    });

    it('returns null when refresh token is expired', async () => {
      // Arrange
      mockRefreshTokenRepository.findById.mockResolvedValue({
        id: 'some-id',
        session_id: TEST_SESSION_ID,
        scope: [SessionTokenScope.RECEIVE_TRANSCRIPTIONS],
        auth_method: 'join_code',
        expiry: new Date(FAKE_NOW.getTime() - 1000),
        secret_hash: TEST_SECRET_HASH,
      });

      // Act
      const result = await service.refreshSessionToken('some-id:valid-secret');

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('getSessionConfig', (it) => {
    it('returns null when session not found', async () => {
      // Arrange
      mockRepository.findSessionById.mockResolvedValue(undefined);

      // Act
      const result = await service.getSessionConfig('nonexistent');

      // Assert
      expect(result).toBeNull();
    });

    it('returns config for existing session', async () => {
      // Arrange
      mockRepository.findSessionById.mockResolvedValue({
        id: TEST_SESSION_ID,
        transcription_provider_key: TEST_PROVIDER_KEY,
        transcription_provider_config: TEST_PROVIDER_CONFIG,
        end_time: TEST_END_TIME,
      });

      // Act
      const result = await service.getSessionConfig(TEST_SESSION_ID);

      // Assert
      expect(result).toEqual({
        transcriptionProviderKey: TEST_PROVIDER_KEY,
        transcriptionProviderConfig: TEST_PROVIDER_CONFIG,
        endTimeUnixMs: TEST_END_TIME.getTime(),
      });
    });

    it('returns null endTimeUnixMs for indefinite session', async () => {
      // Arrange
      mockRepository.findSessionById.mockResolvedValue({
        id: TEST_SESSION_ID,
        transcription_provider_key: TEST_PROVIDER_KEY,
        transcription_provider_config: TEST_PROVIDER_CONFIG,
        end_time: null,
      });

      // Act
      const result = await service.getSessionConfig(TEST_SESSION_ID);

      // Assert
      expect(result).toEqual({
        transcriptionProviderKey: TEST_PROVIDER_KEY,
        transcriptionProviderConfig: TEST_PROVIDER_CONFIG,
        endTimeUnixMs: null,
      });
    });
  });

  describe('endSession', (it) => {
    it('returns false when session not found', async () => {
      // Arrange
      mockRepository.findSessionById.mockResolvedValue(undefined);

      // Act
      const result = await service.endSession('nonexistent');

      // Assert
      expect(result).toBe(false);
    });

    it('returns false when session already ended', async () => {
      // Arrange
      mockRepository.findSessionById.mockResolvedValue({
        id: TEST_SESSION_ID,
        source_device_id: TEST_DEVICE_ID,
        end_time: new Date(FAKE_NOW.getTime() - 1000),
      });

      // Act
      const result = await service.endSession(TEST_SESSION_ID);

      // Assert
      expect(result).toBe(false);
    });

    it('ends session, deletes refresh tokens and join codes, and publishes to redis', async () => {
      // Arrange
      mockRepository.findSessionById.mockResolvedValue({
        id: TEST_SESSION_ID,
        source_device_id: TEST_DEVICE_ID,
        end_time: null,
      });

      // Act
      const result = await service.endSession(TEST_SESSION_ID);

      // Assert
      expect(result).toBe(true);
      expect(mockRepository.endSession).toHaveBeenCalledExactlyOnceWith(
        TEST_SESSION_ID,
        TEST_DEVICE_ID,
        FAKE_NOW,
      );
      expect(
        mockRefreshTokenRepository.deleteBySessionId,
      ).toHaveBeenCalledExactlyOnceWith(TEST_SESSION_ID);
      expect(
        mockJoinCodeRepository.deleteBySessionId,
      ).toHaveBeenCalledExactlyOnceWith(TEST_SESSION_ID);
      expect(mockRedisPublisher.publish).toHaveBeenCalledExactlyOnceWith(
        {
          type: SessionChannelEventType.SESSION_END,
          endTimeUnixMs: FAKE_NOW.getTime(),
        },
        TEST_SESSION_ID,
      );
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
