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
  };
  let mockReply: { send: Mock; code: Mock };
  let controller: SessionManagementController;

  beforeEach(() => {
    mockSessionManagementService = {
      createOnDemandSession: vi.fn(),
      getDeviceSessionEvent: vi.fn(),
      authenticateWithJoinCode: vi.fn(),
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
    it('calls service and responds with sessionId and joinCode on success', async () => {
      // Arrange
      mockSessionManagementService.createOnDemandSession.mockResolvedValue({
        sessionId: TEST_SESSION_ID,
        joinCode: 'ABCD1234',
      });
      const mockReq = {
        body: {
          sourceDeviceId: TEST_DEVICE_ID,
          transcriptionProviderKey: TEST_PROVIDER_KEY,
          transcriptionProviderConfig: TEST_PROVIDER_CONFIG,
          endTimeUnixMs: TEST_END_TIME_MS,
          enableJoinCode: true,
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
      );
      expect(mockReply.code).toHaveBeenCalledExactlyOnceWith(200);
      expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
        sessionId: TEST_SESSION_ID,
        joinCode: 'ABCD1234',
      });
    });

    it('passes enableJoinCode=false when not provided in body', async () => {
      // Arrange
      mockSessionManagementService.createOnDemandSession.mockResolvedValue({
        sessionId: TEST_SESSION_ID,
        joinCode: null,
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
      );
      expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
        sessionId: TEST_SESSION_ID,
        joinCode: null,
      });
    });

    it('throws BadRequest with endTimeUnixMs key when service returns INVALID_END_TIME', async () => {
      // Arrange
      mockSessionManagementService.createOnDemandSession.mockResolvedValue({
        error: 'INVALID_END_TIME',
      });
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
      ).rejects.toThrow(HttpError.BadRequest);
    });

    it('throws BadRequest with sourceDeviceId key when service returns INVALID_SOURCE_DEVICE', async () => {
      // Arrange
      mockSessionManagementService.createOnDemandSession.mockResolvedValue({
        error: 'INVALID_SOURCE_DEVICE',
      });
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
      ).rejects.toThrow(HttpError.BadRequest);
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
    it('responds with sessionToken on success', async () => {
      // Arrange
      mockSessionManagementService.authenticateWithJoinCode.mockResolvedValue({
        sessionToken: 'signed.jwt.token',
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
      });
    });

    it('throws BadRequest when service returns INVALID_JOIN_CODE', async () => {
      // Arrange
      mockSessionManagementService.authenticateWithJoinCode.mockResolvedValue({
        error: 'INVALID_JOIN_CODE',
      });
      const mockReq = { body: { joinCode: 'BADCODE1' } };

      // Act / Assert
      await expect(
        controller.sessionAuth(mockReq as never, mockReply as never),
      ).rejects.toThrow(HttpError.BadRequest);
    });
  });
});
