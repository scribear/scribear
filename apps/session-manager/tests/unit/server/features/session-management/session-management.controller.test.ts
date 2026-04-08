import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { HttpError } from '@scribear/base-fastify-server';
import { DeviceSessionEventType } from '@scribear/session-manager-schema';

import { SessionManagementController } from '#src/server/features/session-management/session-management.controller.js';

const TEST_SESSION_ID = 'test-session-id';
const TEST_DEVICE_ID = 'test-device-id';
const TEST_PROVIDER_KEY = 'whisper';
const TEST_PROVIDER_CONFIG = { apiKey: 'test-api-key' };
const TEST_END_TIME_MS = Date.now() + 60_000;

describe('SessionManagementController', () => {
  let mockSessionManagementService: {
    createOnDemandSession: Mock;
    getDeviceSessionEvent: Mock;
    authenticateWithJoinCode: Mock;
    authenticateSourceDevice: Mock;
    refreshSessionToken: Mock;
    getSessionJoinCode: Mock;
    getSessionConfig: Mock;
    endSession: Mock;
  };
  let mockReply: { send: Mock; code: Mock };
  let controller: SessionManagementController;

  beforeEach(() => {
    mockSessionManagementService = {
      createOnDemandSession: vi.fn(),
      getDeviceSessionEvent: vi.fn(),
      authenticateWithJoinCode: vi.fn(),
      authenticateSourceDevice: vi.fn(),
      refreshSessionToken: vi.fn(),
      getSessionJoinCode: vi.fn(),
      getSessionConfig: vi.fn(),
      endSession: vi.fn(),
    };
    controller = new SessionManagementController(
      mockSessionManagementService as never,
    );

    mockReply = {
      send: vi.fn(),
      code: vi.fn().mockReturnThis(),
    };
  });

  describe('createSession', (it) => {
    it('calls service and responds with sessionId on success', async () => {
      // Arrange
      mockSessionManagementService.createOnDemandSession.mockResolvedValue({
        sessionId: TEST_SESSION_ID,
      });
      const mockReq = {
        body: {
          sourceDeviceId: TEST_DEVICE_ID,
          transcriptionProviderKey: TEST_PROVIDER_KEY,
          transcriptionProviderConfig: TEST_PROVIDER_CONFIG,
          endTimeUnixMs: TEST_END_TIME_MS,
          enableJoinCode: true,
          joinCodeLength: 6,
          enableJoinCodeRotation: true,
        },
      };

      // Act
      await controller.createSession(mockReq as never, mockReply as never);

      // Assert
      expect(
        mockSessionManagementService.createOnDemandSession,
      ).toHaveBeenCalledExactlyOnceWith(
        TEST_DEVICE_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        TEST_END_TIME_MS,
        true,
        6,
        true,
      );
      expect(mockReply.code).toHaveBeenCalledExactlyOnceWith(200);
      expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
        sessionId: TEST_SESSION_ID,
      });
    });

    it('passes enableJoinCode=false and undefined optional params when not provided', async () => {
      // Arrange
      mockSessionManagementService.createOnDemandSession.mockResolvedValue({
        sessionId: TEST_SESSION_ID,
      });
      const mockReq = {
        body: {
          sourceDeviceId: TEST_DEVICE_ID,
          transcriptionProviderKey: TEST_PROVIDER_KEY,
          transcriptionProviderConfig: TEST_PROVIDER_CONFIG,
          endTimeUnixMs: TEST_END_TIME_MS,
        },
      };

      // Act
      await controller.createSession(mockReq as never, mockReply as never);

      // Assert
      expect(
        mockSessionManagementService.createOnDemandSession,
      ).toHaveBeenCalledExactlyOnceWith(
        TEST_DEVICE_ID,
        TEST_PROVIDER_KEY,
        TEST_PROVIDER_CONFIG,
        TEST_END_TIME_MS,
        false,
        undefined,
        undefined,
      );
      expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
        sessionId: TEST_SESSION_ID,
      });
    });

    it('throws UnprocessableEntity when service returns null', async () => {
      // Arrange
      mockSessionManagementService.createOnDemandSession.mockResolvedValue(
        null,
      );
      const mockReq = {
        body: {
          sourceDeviceId: TEST_DEVICE_ID,
          transcriptionProviderKey: TEST_PROVIDER_KEY,
          transcriptionProviderConfig: TEST_PROVIDER_CONFIG,
          endTimeUnixMs: TEST_END_TIME_MS,
        },
      };

      // Act / Assert
      await expect(
        controller.createSession(mockReq as never, mockReply as never),
      ).rejects.toThrow(HttpError.UnprocessableEntity);
    });
  });

  describe('getDeviceSessionEvents', (it) => {
    it('responds with session event when service returns one', async () => {
      // Arrange
      const sessionEvent = {
        eventId: 1,
        eventType: DeviceSessionEventType.START_SESSION,
        sessionId: TEST_SESSION_ID,
        timestampUnixMs: Date.now(),
      };
      mockSessionManagementService.getDeviceSessionEvent.mockResolvedValue(
        sessionEvent,
      );
      const mockReq = {
        deviceId: TEST_DEVICE_ID,
        query: { prevEventId: undefined },
      };

      // Act
      await controller.getDeviceSessionEvents(
        mockReq as never,
        mockReply as never,
      );

      // Assert
      expect(
        mockSessionManagementService.getDeviceSessionEvent,
      ).toHaveBeenCalledExactlyOnceWith(TEST_DEVICE_ID, undefined);
      expect(mockReply.code).toHaveBeenCalledExactlyOnceWith(200);
      expect(mockReply.send).toHaveBeenCalledExactlyOnceWith(sessionEvent);
    });

    it('responds with null when service returns null', async () => {
      // Arrange
      mockSessionManagementService.getDeviceSessionEvent.mockResolvedValue(
        null,
      );
      const mockReq = {
        deviceId: TEST_DEVICE_ID,
        query: { prevEventId: 5 },
      };

      // Act
      await controller.getDeviceSessionEvents(
        mockReq as never,
        mockReply as never,
      );

      // Assert
      expect(
        mockSessionManagementService.getDeviceSessionEvent,
      ).toHaveBeenCalledExactlyOnceWith(TEST_DEVICE_ID, 5);
      expect(mockReply.send).toHaveBeenCalledExactlyOnceWith(null);
    });
  });

  describe('sessionAuth', (it) => {
    it('responds with sessionToken and sessionRefreshToken on success', async () => {
      // Arrange
      mockSessionManagementService.authenticateWithJoinCode.mockResolvedValue({
        sessionToken: 'signed.jwt.token',
        sessionRefreshToken: 'refresh-token-id:secret',
      });
      const mockReq = { body: { joinCode: 'ABCD1234' } };

      // Act
      await controller.sessionAuth(mockReq as never, mockReply as never);

      // Assert
      expect(
        mockSessionManagementService.authenticateWithJoinCode,
      ).toHaveBeenCalledExactlyOnceWith('ABCD1234');
      expect(mockReply.code).toHaveBeenCalledExactlyOnceWith(200);
      expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
        sessionToken: 'signed.jwt.token',
        sessionRefreshToken: 'refresh-token-id:secret',
      });
    });

    it('throws UnprocessableEntity when service returns null', async () => {
      // Arrange
      mockSessionManagementService.authenticateWithJoinCode.mockResolvedValue(
        null,
      );
      const mockReq = { body: { joinCode: 'BADCODE1' } };

      // Act / Assert
      await expect(
        controller.sessionAuth(mockReq as never, mockReply as never),
      ).rejects.toThrow(HttpError.UnprocessableEntity);
    });
  });

  describe('sourceDeviceSessionAuth', (it) => {
    it('calls service with deviceId from request and sessionId from body', async () => {
      // Arrange
      mockSessionManagementService.authenticateSourceDevice.mockResolvedValue({
        sessionToken: 'signed.jwt.token',
        sessionRefreshToken: 'refresh-token-id:secret',
      });
      const mockReq = {
        deviceId: TEST_DEVICE_ID,
        body: { sessionId: TEST_SESSION_ID },
      };

      // Act
      await controller.sourceDeviceSessionAuth(
        mockReq as never,
        mockReply as never,
      );

      // Assert
      expect(
        mockSessionManagementService.authenticateSourceDevice,
      ).toHaveBeenCalledExactlyOnceWith(TEST_DEVICE_ID, TEST_SESSION_ID);
    });

    it('responds with sessionToken and sessionRefreshToken on success', async () => {
      // Arrange
      mockSessionManagementService.authenticateSourceDevice.mockResolvedValue({
        sessionToken: 'signed.jwt.token',
        sessionRefreshToken: 'refresh-token-id:secret',
      });
      const mockReq = {
        deviceId: TEST_DEVICE_ID,
        body: { sessionId: TEST_SESSION_ID },
      };

      // Act
      await controller.sourceDeviceSessionAuth(
        mockReq as never,
        mockReply as never,
      );

      // Assert
      expect(mockReply.code).toHaveBeenCalledExactlyOnceWith(200);
      expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
        sessionToken: 'signed.jwt.token',
        sessionRefreshToken: 'refresh-token-id:secret',
      });
    });

    it('throws Unauthorized when service returns null', async () => {
      // Arrange
      mockSessionManagementService.authenticateSourceDevice.mockResolvedValue(
        null,
      );
      const mockReq = {
        deviceId: TEST_DEVICE_ID,
        body: { sessionId: TEST_SESSION_ID },
      };

      // Act / Assert
      await expect(
        controller.sourceDeviceSessionAuth(
          mockReq as never,
          mockReply as never,
        ),
      ).rejects.toThrow(HttpError.Unauthorized);
    });
  });

  describe('refreshSessionToken', (it) => {
    it('responds with new sessionToken on success', async () => {
      // Arrange
      mockSessionManagementService.refreshSessionToken.mockResolvedValue({
        sessionToken: 'new.jwt.token',
      });
      const mockReq = { body: { sessionRefreshToken: 'id:secret' } };

      // Act
      await controller.refreshSessionToken(
        mockReq as never,
        mockReply as never,
      );

      // Assert
      expect(
        mockSessionManagementService.refreshSessionToken,
      ).toHaveBeenCalledExactlyOnceWith('id:secret');
      expect(mockReply.code).toHaveBeenCalledExactlyOnceWith(200);
      expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
        sessionToken: 'new.jwt.token',
      });
    });

    it('throws Unauthorized when service returns null', async () => {
      // Arrange
      mockSessionManagementService.refreshSessionToken.mockResolvedValue(null);
      const mockReq = { body: { sessionRefreshToken: 'bad:token' } };

      // Act / Assert
      await expect(
        controller.refreshSessionToken(mockReq as never, mockReply as never),
      ).rejects.toThrow(HttpError.Unauthorized);
    });
  });

  describe('getSessionJoinCode', (it) => {
    it('responds with joinCode and expiresAtUnixMs on success', async () => {
      // Arrange
      const expiresAtUnixMs = Date.now() + 300_000;
      mockSessionManagementService.getSessionJoinCode.mockResolvedValue({
        joinCode: 'ABCD1234',
        expiresAtUnixMs,
      });
      const mockReq = {
        deviceId: TEST_DEVICE_ID,
        params: { sessionId: TEST_SESSION_ID },
      };

      // Act
      await controller.getSessionJoinCode(mockReq as never, mockReply as never);

      // Assert
      expect(
        mockSessionManagementService.getSessionJoinCode,
      ).toHaveBeenCalledExactlyOnceWith(TEST_DEVICE_ID, TEST_SESSION_ID);
      expect(mockReply.code).toHaveBeenCalledExactlyOnceWith(200);
      expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
        joinCode: 'ABCD1234',
        expiresAtUnixMs,
      });
    });

    it('throws NotFound when service returns null', async () => {
      // Arrange
      mockSessionManagementService.getSessionJoinCode.mockResolvedValue(null);
      const mockReq = {
        deviceId: TEST_DEVICE_ID,
        params: { sessionId: TEST_SESSION_ID },
      };

      // Act / Assert
      await expect(
        controller.getSessionJoinCode(mockReq as never, mockReply as never),
      ).rejects.toThrow(HttpError.NotFound);
    });
  });

  describe('getSessionConfig', (it) => {
    it('responds with session config on success', async () => {
      // Arrange
      mockSessionManagementService.getSessionConfig.mockResolvedValue({
        transcriptionProviderKey: TEST_PROVIDER_KEY,
        transcriptionProviderConfig: TEST_PROVIDER_CONFIG,
        endTimeUnixMs: TEST_END_TIME_MS,
      });
      const mockReq = { params: { sessionId: TEST_SESSION_ID } };

      // Act
      await controller.getSessionConfig(mockReq as never, mockReply as never);

      // Assert
      expect(
        mockSessionManagementService.getSessionConfig,
      ).toHaveBeenCalledExactlyOnceWith(TEST_SESSION_ID);
      expect(mockReply.code).toHaveBeenCalledExactlyOnceWith(200);
      expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
        transcriptionProviderKey: TEST_PROVIDER_KEY,
        transcriptionProviderConfig: TEST_PROVIDER_CONFIG,
        endTimeUnixMs: TEST_END_TIME_MS,
      });
    });

    it('throws NotFound when service returns null', async () => {
      // Arrange
      mockSessionManagementService.getSessionConfig.mockResolvedValue(null);
      const mockReq = { params: { sessionId: 'nonexistent' } };

      // Act / Assert
      await expect(
        controller.getSessionConfig(mockReq as never, mockReply as never),
      ).rejects.toThrow(HttpError.NotFound);
    });
  });

  describe('endSession', (it) => {
    it('responds with empty object on success', async () => {
      // Arrange
      mockSessionManagementService.endSession.mockResolvedValue(true);
      const mockReq = { body: { sessionId: TEST_SESSION_ID } };

      // Act
      await controller.endSession(mockReq as never, mockReply as never);

      // Assert
      expect(
        mockSessionManagementService.endSession,
      ).toHaveBeenCalledExactlyOnceWith(TEST_SESSION_ID);
      expect(mockReply.code).toHaveBeenCalledExactlyOnceWith(200);
      expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({});
    });

    it('throws NotFound when service returns false', async () => {
      // Arrange
      mockSessionManagementService.endSession.mockResolvedValue(false);
      const mockReq = { body: { sessionId: 'nonexistent' } };

      // Act / Assert
      await expect(
        controller.endSession(mockReq as never, mockReply as never),
      ).rejects.toThrow(HttpError.NotFound);
    });
  });
});
