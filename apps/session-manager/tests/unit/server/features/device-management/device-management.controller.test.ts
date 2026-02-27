import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { HttpError } from '@scribear/base-fastify-server';

import { DeviceManagementController } from '#src/server/features/device-management/device-management.controller.js';

const TEST_DEVICE_ID = 'test-device-id';
const TEST_DEVICE_NAME = 'my-device';
const TEST_ACTIVATION_CODE = 'ABCD1234';
const TEST_DEVICE_SECRET = 'supersecret';
const TEST_COOKIE_VALUE = `${TEST_DEVICE_ID}:${TEST_DEVICE_SECRET}`;

describe('DeviceManagementController', () => {
  let mockDeviceManagementService: {
    registerDevice: Mock;
    activateDevice: Mock;
  };
  let mockAuthService: { encodeDeviceToken: Mock };
  let mockReply: { send: Mock; code: Mock; setCookie: Mock };

  function makeController(isDevelopment: boolean) {
    return new DeviceManagementController(
      { isDevelopment } as never,
      mockDeviceManagementService as never,
      mockAuthService as never,
    );
  }

  beforeEach(() => {
    mockDeviceManagementService = {
      registerDevice: vi.fn(),
      activateDevice: vi.fn(),
    };
    mockAuthService = { encodeDeviceToken: vi.fn() };
    mockReply = {
      send: vi.fn(),
      code: vi.fn().mockReturnThis(),
      setCookie: vi.fn().mockReturnThis(),
    };
  });

  describe('registerDevice', (it) => {
    it('calls service and responds with deviceId and activationCode', async () => {
      // Arrange
      mockDeviceManagementService.registerDevice.mockResolvedValue({
        deviceId: TEST_DEVICE_ID,
        activationCode: TEST_ACTIVATION_CODE,
      });
      const controller = makeController(false);
      const mockReq = { body: { deviceName: TEST_DEVICE_NAME } };

      // Act
      await controller.registerDevice(mockReq as never, mockReply as never);

      // Assert
      expect(
        mockDeviceManagementService.registerDevice,
      ).toHaveBeenCalledExactlyOnceWith(TEST_DEVICE_NAME);
      expect(mockReply.code).toHaveBeenCalledExactlyOnceWith(200);
      expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
        deviceId: TEST_DEVICE_ID,
        activationCode: TEST_ACTIVATION_CODE,
      });
    });
  });

  describe('activateDevice', (it) => {
    it('throws BadRequest when service returns null', async () => {
      // Arrange
      mockDeviceManagementService.activateDevice.mockResolvedValue(null);
      const controller = makeController(false);
      const mockReq = { body: { activationCode: TEST_ACTIVATION_CODE } };

      // Act / Assert
      await expect(
        controller.activateDevice(mockReq as never, mockReply as never),
      ).rejects.toThrow(HttpError.BadRequest);
    });

    it('sets httpOnly cookie and responds with deviceId and deviceName on success', async () => {
      // Arrange
      mockDeviceManagementService.activateDevice.mockResolvedValue({
        deviceId: TEST_DEVICE_ID,
        deviceName: TEST_DEVICE_NAME,
        deviceSecret: TEST_DEVICE_SECRET,
      });
      mockAuthService.encodeDeviceToken.mockReturnValue(TEST_COOKIE_VALUE);
      const controller = makeController(false);
      const mockReq = { body: { activationCode: TEST_ACTIVATION_CODE } };

      // Act
      await controller.activateDevice(mockReq as never, mockReply as never);

      // Assert
      expect(mockAuthService.encodeDeviceToken).toHaveBeenCalledExactlyOnceWith(
        TEST_DEVICE_ID,
        TEST_DEVICE_SECRET,
      );
      expect(mockReply.setCookie).toHaveBeenCalledExactlyOnceWith(
        'device_token',
        TEST_COOKIE_VALUE,
        expect.objectContaining({
          httpOnly: true,
          path: '/',
          sameSite: 'strict',
        }),
      );
      expect(mockReply.code).toHaveBeenCalledExactlyOnceWith(200);
      expect(mockReply.send).toHaveBeenCalledExactlyOnceWith({
        deviceId: TEST_DEVICE_ID,
        deviceName: TEST_DEVICE_NAME,
      });
    });

    it('sets secure cookie in production', async () => {
      // Arrange
      mockDeviceManagementService.activateDevice.mockResolvedValue({
        deviceId: TEST_DEVICE_ID,
        deviceName: TEST_DEVICE_NAME,
        deviceSecret: TEST_DEVICE_SECRET,
      });
      mockAuthService.encodeDeviceToken.mockReturnValue(TEST_COOKIE_VALUE);
      const controller = makeController(false);
      const mockReq = { body: { activationCode: TEST_ACTIVATION_CODE } };

      // Act
      await controller.activateDevice(mockReq as never, mockReply as never);

      // Assert
      expect(mockReply.setCookie).toHaveBeenCalledWith(
        'device_token',
        TEST_COOKIE_VALUE,
        expect.objectContaining({ secure: true }),
      );
    });

    it('sets insecure cookie in development', async () => {
      // Arrange
      mockDeviceManagementService.activateDevice.mockResolvedValue({
        deviceId: TEST_DEVICE_ID,
        deviceName: TEST_DEVICE_NAME,
        deviceSecret: TEST_DEVICE_SECRET,
      });
      mockAuthService.encodeDeviceToken.mockReturnValue(TEST_COOKIE_VALUE);
      const controller = makeController(true);
      const mockReq = { body: { activationCode: TEST_ACTIVATION_CODE } };

      // Act
      await controller.activateDevice(mockReq as never, mockReply as never);

      // Assert
      expect(mockReply.setCookie).toHaveBeenCalledWith(
        'device_token',
        TEST_COOKIE_VALUE,
        expect.objectContaining({ secure: false }),
      );
    });
  });
});
