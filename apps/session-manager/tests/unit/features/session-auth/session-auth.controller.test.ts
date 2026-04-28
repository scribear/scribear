import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { SessionAuthController } from '#src/server/features/session-auth/session-auth.controller.js';

const SESSION_UID = 'session-1';
const DEVICE_UID = 'device-1';
const FAKE_VALID_START = new Date('2026-04-27T11:55:00.000Z');
const FAKE_VALID_END = new Date('2026-04-27T12:00:00.000Z');
const FAKE_NEXT_END = new Date('2026-04-27T12:05:00.000Z');
const FAKE_TOKEN_EXPIRES = new Date('2026-04-27T12:05:00.000Z');

describe('SessionAuthController', () => {
  let mockService: {
    fetchJoinCodes: Mock;
    exchangeDeviceToken: Mock;
    exchangeJoinCode: Mock;
    refreshSessionToken: Mock;
  };
  let controller: SessionAuthController;
  let mockSend: Mock;
  let mockCode: Mock;
  let mockRes: { code: Mock };

  beforeEach(() => {
    mockService = {
      fetchJoinCodes: vi.fn(),
      exchangeDeviceToken: vi.fn(),
      exchangeJoinCode: vi.fn(),
      refreshSessionToken: vi.fn(),
    };

    controller = new SessionAuthController(mockService as never);

    mockSend = vi.fn();
    mockCode = vi.fn().mockReturnValue({ send: mockSend });
    mockRes = { code: mockCode };
  });

  describe('fetchJoinCode', (it) => {
    it('throws 500 when the device cookie did not populate req.deviceUid', async () => {
      // Arrange
      const mockReq = { body: { sessionUid: SESSION_UID } };

      // Act + Assert
      await expect(
        controller.fetchJoinCode(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 500 });
    });

    it("throws 404 when the service returns 'SESSION_NOT_FOUND'", async () => {
      // Arrange
      mockService.fetchJoinCodes.mockResolvedValue('SESSION_NOT_FOUND');
      const mockReq = {
        deviceUid: DEVICE_UID,
        body: { sessionUid: SESSION_UID },
      };

      // Act + Assert
      await expect(
        controller.fetchJoinCode(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: 'SESSION_NOT_FOUND',
      });
    });

    it("throws 403 when the service returns 'DEVICE_NOT_IN_SESSION_ROOM'", async () => {
      // Arrange
      mockService.fetchJoinCodes.mockResolvedValue(
        'DEVICE_NOT_IN_SESSION_ROOM',
      );
      const mockReq = {
        deviceUid: DEVICE_UID,
        body: { sessionUid: SESSION_UID },
      };

      // Act + Assert
      await expect(
        controller.fetchJoinCode(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'DEVICE_NOT_IN_SESSION_ROOM',
      });
    });

    it("throws 409 when the service returns 'JOIN_CODE_SCOPES_EMPTY'", async () => {
      // Arrange
      mockService.fetchJoinCodes.mockResolvedValue('JOIN_CODE_SCOPES_EMPTY');
      const mockReq = {
        deviceUid: DEVICE_UID,
        body: { sessionUid: SESSION_UID },
      };

      // Act + Assert
      await expect(
        controller.fetchJoinCode(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'JOIN_CODE_SCOPES_EMPTY',
      });
    });

    it('serializes Date fields to ISO strings on success', async () => {
      // Arrange
      mockService.fetchJoinCodes.mockResolvedValue({
        current: {
          joinCode: 'AAAA1111',
          validStart: FAKE_VALID_START,
          validEnd: FAKE_VALID_END,
        },
        next: null,
      });
      const mockReq = {
        deviceUid: DEVICE_UID,
        body: { sessionUid: SESSION_UID },
      };

      // Act
      await controller.fetchJoinCode(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith({
        current: {
          joinCode: 'AAAA1111',
          validStart: FAKE_VALID_START.toISOString(),
          validEnd: FAKE_VALID_END.toISOString(),
        },
        next: null,
      });
    });

    it('serializes both current and next codes when present', async () => {
      // Arrange
      mockService.fetchJoinCodes.mockResolvedValue({
        current: {
          joinCode: 'AAAA1111',
          validStart: FAKE_VALID_START,
          validEnd: FAKE_VALID_END,
        },
        next: {
          joinCode: 'BBBB2222',
          validStart: FAKE_VALID_END,
          validEnd: FAKE_NEXT_END,
        },
      });
      const mockReq = {
        deviceUid: DEVICE_UID,
        body: { sessionUid: SESSION_UID },
      };

      // Act
      await controller.fetchJoinCode(mockReq as never, mockRes as never);

      // Assert
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          next: {
            joinCode: 'BBBB2222',
            validStart: FAKE_VALID_END.toISOString(),
            validEnd: FAKE_NEXT_END.toISOString(),
          },
        }),
      );
    });
  });

  describe('exchangeDeviceToken', (it) => {
    it('throws 500 when req.deviceUid is missing', async () => {
      // Arrange
      const mockReq = { body: { sessionUid: SESSION_UID } };

      // Act + Assert
      await expect(
        controller.exchangeDeviceToken(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 500 });
    });

    it("throws 404 when the service returns 'SESSION_NOT_FOUND'", async () => {
      // Arrange
      mockService.exchangeDeviceToken.mockResolvedValue('SESSION_NOT_FOUND');
      const mockReq = {
        deviceUid: DEVICE_UID,
        body: { sessionUid: SESSION_UID },
      };

      // Act + Assert
      await expect(
        controller.exchangeDeviceToken(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: 'SESSION_NOT_FOUND',
      });
    });

    it("throws 403 when the service returns 'DEVICE_NOT_IN_SESSION_ROOM'", async () => {
      // Arrange
      mockService.exchangeDeviceToken.mockResolvedValue(
        'DEVICE_NOT_IN_SESSION_ROOM',
      );
      const mockReq = {
        deviceUid: DEVICE_UID,
        body: { sessionUid: SESSION_UID },
      };

      // Act + Assert
      await expect(
        controller.exchangeDeviceToken(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 403,
        code: 'DEVICE_NOT_IN_SESSION_ROOM',
      });
    });

    it("throws 409 when the service returns 'SESSION_NOT_CURRENTLY_ACTIVE'", async () => {
      // Arrange
      mockService.exchangeDeviceToken.mockResolvedValue(
        'SESSION_NOT_CURRENTLY_ACTIVE',
      );
      const mockReq = {
        deviceUid: DEVICE_UID,
        body: { sessionUid: SESSION_UID },
      };

      // Act + Assert
      await expect(
        controller.exchangeDeviceToken(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'SESSION_NOT_CURRENTLY_ACTIVE',
      });
    });

    it('returns 200 with the issued token and ISO-formatted expiry', async () => {
      // Arrange
      mockService.exchangeDeviceToken.mockResolvedValue({
        sessionToken: 'token',
        sessionTokenExpiresAt: FAKE_TOKEN_EXPIRES,
        scopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
      });
      const mockReq = {
        deviceUid: DEVICE_UID,
        body: { sessionUid: SESSION_UID },
      };

      // Act
      await controller.exchangeDeviceToken(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith({
        sessionToken: 'token',
        sessionTokenExpiresAt: FAKE_TOKEN_EXPIRES.toISOString(),
        scopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
      });
    });
  });

  describe('exchangeJoinCode', (it) => {
    it("throws 404 when the service returns 'JOIN_CODE_NOT_FOUND'", async () => {
      // Arrange
      mockService.exchangeJoinCode.mockResolvedValue('JOIN_CODE_NOT_FOUND');
      const mockReq = { body: { joinCode: 'NOPE0000' } };

      // Act + Assert
      await expect(
        controller.exchangeJoinCode(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: 'JOIN_CODE_NOT_FOUND',
      });
    });

    it("throws 410 when the service returns 'JOIN_CODE_EXPIRED'", async () => {
      // Arrange
      mockService.exchangeJoinCode.mockResolvedValue('JOIN_CODE_EXPIRED');
      const mockReq = { body: { joinCode: 'OLD00000' } };

      // Act + Assert
      await expect(
        controller.exchangeJoinCode(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 410,
        code: 'JOIN_CODE_EXPIRED',
      });
    });

    it("throws 409 when the service returns 'SESSION_NOT_CURRENTLY_ACTIVE'", async () => {
      // Arrange
      mockService.exchangeJoinCode.mockResolvedValue(
        'SESSION_NOT_CURRENTLY_ACTIVE',
      );
      const mockReq = { body: { joinCode: 'AAAA1111' } };

      // Act + Assert
      await expect(
        controller.exchangeJoinCode(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'SESSION_NOT_CURRENTLY_ACTIVE',
      });
    });

    it('returns 200 with sessionUid, clientId, tokens, and scopes', async () => {
      // Arrange
      mockService.exchangeJoinCode.mockResolvedValue({
        sessionUid: SESSION_UID,
        clientId: 'client-1',
        sessionToken: 'session-token',
        sessionTokenExpiresAt: FAKE_TOKEN_EXPIRES,
        sessionRefreshToken: 'uid:secret',
        scopes: ['RECEIVE_TRANSCRIPTIONS'],
      });
      const mockReq = { body: { joinCode: 'AAAA1111' } };

      // Act
      await controller.exchangeJoinCode(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith({
        sessionUid: SESSION_UID,
        clientId: 'client-1',
        sessionToken: 'session-token',
        sessionTokenExpiresAt: FAKE_TOKEN_EXPIRES.toISOString(),
        sessionRefreshToken: 'uid:secret',
        scopes: ['RECEIVE_TRANSCRIPTIONS'],
      });
    });
  });

  describe('refreshSessionToken', (it) => {
    it("throws 401 with INVALID_REFRESH_TOKEN code when the service returns 'INVALID_REFRESH_TOKEN'", async () => {
      // Arrange
      mockService.refreshSessionToken.mockResolvedValue(
        'INVALID_REFRESH_TOKEN',
      );
      const mockReq = { body: { sessionRefreshToken: 'bad-token' } };

      // Act + Assert
      await expect(
        controller.refreshSessionToken(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 401,
        code: 'INVALID_REFRESH_TOKEN',
      });
    });

    it("throws 409 when the service returns 'SESSION_ENDED'", async () => {
      // Arrange
      mockService.refreshSessionToken.mockResolvedValue('SESSION_ENDED');
      const mockReq = { body: { sessionRefreshToken: 'uid:secret' } };

      // Act + Assert
      await expect(
        controller.refreshSessionToken(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'SESSION_ENDED',
      });
    });

    it('returns 200 with the refreshed token', async () => {
      // Arrange
      mockService.refreshSessionToken.mockResolvedValue({
        sessionToken: 'new-token',
        sessionTokenExpiresAt: FAKE_TOKEN_EXPIRES,
      });
      const mockReq = { body: { sessionRefreshToken: 'uid:secret' } };

      // Act
      await controller.refreshSessionToken(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith({
        sessionToken: 'new-token',
        sessionTokenExpiresAt: FAKE_TOKEN_EXPIRES.toISOString(),
      });
    });
  });
});
