import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { DeviceManagementController } from '#src/server/features/device-management/device-management.controller.js';

const FAKE_DATE = new Date('2025-01-01T00:00:00.000Z');
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const mockDevice = {
  uid: 'device-1',
  name: 'Test Device',
  active: true,
  createdAt: FAKE_DATE,
  roomUid: null,
  isSource: null,
};

describe('DeviceManagementController', () => {
  let mockService: {
    listDevices: Mock;
    getDevice: Mock;
    registerDevice: Mock;
    reregisterDevice: Mock;
    activateDevice: Mock;
    updateDevice: Mock;
    deleteDevice: Mock;
    getMyDevice: Mock;
  };
  let mockDeviceAuthService: { encode: Mock };
  let controller: DeviceManagementController;
  let mockSend: Mock;
  let mockCode: Mock;
  let mockSetCookie: Mock;
  let mockRes: { code: Mock; setCookie: Mock };

  beforeEach(() => {
    mockService = {
      listDevices: vi.fn(),
      getDevice: vi.fn(),
      registerDevice: vi.fn(),
      reregisterDevice: vi.fn(),
      activateDevice: vi.fn(),
      updateDevice: vi.fn(),
      deleteDevice: vi.fn(),
      getMyDevice: vi.fn(),
    };
    mockDeviceAuthService = {
      encode: vi.fn().mockReturnValue('encoded-token'),
    };

    controller = new DeviceManagementController(
      { isDevelopment: true } as never,
      mockService as never,
      mockDeviceAuthService as never,
    );

    mockSend = vi.fn();
    mockCode = vi.fn().mockReturnValue({ send: mockSend });
    mockSetCookie = vi.fn();
    mockRes = { code: mockCode, setCookie: mockSetCookie };
  });

  describe('listDevices', (it) => {
    it('serializes createdAt to ISO string for each item', async () => {
      // Arrange
      mockService.listDevices.mockResolvedValue({
        items: [mockDevice],
        nextCursor: null,
      });
      const mockReq = {
        query: { search: null, active: null, roomUid: null, cursor: null },
      };

      // Act
      await controller.listDevices(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith({
        items: [{ ...mockDevice, createdAt: FAKE_DATE.toISOString() }],
        nextCursor: null,
      });
    });

    it('uses default limit of 50 when not provided', async () => {
      // Arrange
      mockService.listDevices.mockResolvedValue({
        items: [],
        nextCursor: null,
      });
      const mockReq = {
        query: {
          search: undefined,
          active: undefined,
          roomUid: undefined,
          cursor: undefined,
        },
      };

      // Act
      await controller.listDevices(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.listDevices).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 }),
      );
    });

    it('forwards all query params to the service', async () => {
      // Arrange
      mockService.listDevices.mockResolvedValue({
        items: [],
        nextCursor: null,
      });
      const mockReq = {
        query: {
          search: 'tablet',
          active: true,
          roomUid: 'room-1',
          cursor: 'abc',
          limit: 10,
        },
      };

      // Act
      await controller.listDevices(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.listDevices).toHaveBeenCalledWith({
        search: 'tablet',
        active: true,
        roomUid: 'room-1',
        cursor: 'abc',
        limit: 10,
      });
    });
  });

  describe('getDevice', (it) => {
    it('calls the service with the deviceUid from params', async () => {
      // Arrange
      mockService.getDevice.mockResolvedValue(mockDevice);
      const mockReq = { params: { deviceUid: 'device-1' } };

      // Act
      await controller.getDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.getDevice).toHaveBeenCalledWith('device-1');
    });

    it("throws 404 when service returns 'DEVICE_NOT_FOUND'", async () => {
      // Arrange
      mockService.getDevice.mockResolvedValue('DEVICE_NOT_FOUND');
      const mockReq = { params: { deviceUid: 'device-1' } };

      // Act + Assert
      await expect(
        controller.getDevice(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 404, code: 'DEVICE_NOT_FOUND' });
    });

    it('serializes createdAt to ISO string', async () => {
      // Arrange
      mockService.getDevice.mockResolvedValue(mockDevice);
      const mockReq = { params: { deviceUid: 'device-1' } };

      // Act
      await controller.getDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ createdAt: FAKE_DATE.toISOString() }),
      );
    });
  });

  describe('registerDevice', (it) => {
    it('calls the service with the name from the body', async () => {
      // Arrange
      mockService.registerDevice.mockResolvedValue({
        deviceUid: 'device-1',
        activationCode: 'ABCD1234',
        expiry: FAKE_DATE,
      });
      const mockReq = { body: { name: 'Test Device' } };

      // Act
      await controller.registerDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.registerDevice).toHaveBeenCalledWith('Test Device');
    });

    it('serializes expiry to ISO string', async () => {
      // Arrange
      mockService.registerDevice.mockResolvedValue({
        deviceUid: 'device-1',
        activationCode: 'ABCD1234',
        expiry: FAKE_DATE,
      });
      const mockReq = { body: { name: 'Test Device' } };

      // Act
      await controller.registerDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(201);
      expect(mockSend).toHaveBeenCalledWith({
        deviceUid: 'device-1',
        activationCode: 'ABCD1234',
        expiry: FAKE_DATE.toISOString(),
      });
    });
  });

  describe('reregisterDevice', (it) => {
    it('calls the service with the deviceUid from the body', async () => {
      // Arrange
      mockService.reregisterDevice.mockResolvedValue({
        activationCode: 'ABCD1234',
        expiry: FAKE_DATE,
      });
      const mockReq = { body: { deviceUid: 'device-1' } };

      // Act
      await controller.reregisterDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.reregisterDevice).toHaveBeenCalledWith('device-1');
    });

    it("throws 404 when service returns 'DEVICE_NOT_FOUND'", async () => {
      // Arrange
      mockService.reregisterDevice.mockResolvedValue('DEVICE_NOT_FOUND');
      const mockReq = { body: { deviceUid: 'device-1' } };

      // Act + Assert
      await expect(
        controller.reregisterDevice(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 404, code: 'DEVICE_NOT_FOUND' });
    });

    it('serializes expiry to ISO string', async () => {
      // Arrange
      mockService.reregisterDevice.mockResolvedValue({
        activationCode: 'ABCD1234',
        expiry: FAKE_DATE,
      });
      const mockReq = { body: { deviceUid: 'device-1' } };

      // Act
      await controller.reregisterDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith({
        activationCode: 'ABCD1234',
        expiry: FAKE_DATE.toISOString(),
      });
    });
  });

  describe('activateDevice', (it) => {
    it('calls the service with the activationCode from the body', async () => {
      // Arrange
      mockService.activateDevice.mockResolvedValue({
        deviceUid: 'device-1',
        secret: 'plain-secret',
      });
      const mockReq = { body: { activationCode: 'ABCD1234' } };

      // Act
      await controller.activateDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.activateDevice).toHaveBeenCalledWith('ABCD1234');
    });

    it("throws 404 when service returns 'ACTIVATION_CODE_NOT_FOUND'", async () => {
      // Arrange
      mockService.activateDevice.mockResolvedValue('ACTIVATION_CODE_NOT_FOUND');
      const mockReq = { body: { activationCode: 'ABCD1234' } };

      // Act + Assert
      await expect(
        controller.activateDevice(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: 'ACTIVATION_CODE_NOT_FOUND',
      });
    });

    it("throws 410 when service returns 'ACTIVATION_CODE_EXPIRED'", async () => {
      // Arrange
      mockService.activateDevice.mockResolvedValue('ACTIVATION_CODE_EXPIRED');
      const mockReq = { body: { activationCode: 'ABCD1234' } };

      // Act + Assert
      await expect(
        controller.activateDevice(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 410,
        code: 'ACTIVATION_CODE_EXPIRED',
      });
    });

    it('sets an httpOnly cookie with the encoded device token', async () => {
      // Arrange
      mockService.activateDevice.mockResolvedValue({
        deviceUid: 'device-1',
        secret: 'plain-secret',
      });
      mockDeviceAuthService.encode.mockReturnValue('encoded-token');
      const mockReq = { body: { activationCode: 'ABCD1234' } };

      // Act
      await controller.activateDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockDeviceAuthService.encode).toHaveBeenCalledWith(
        'device-1',
        'plain-secret',
      );
      expect(mockSetCookie).toHaveBeenCalledWith(
        'DEVICE_TOKEN',
        'encoded-token',
        expect.objectContaining({
          httpOnly: true,
          path: '/',
          sameSite: 'strict',
          maxAge: COOKIE_MAX_AGE_SECONDS,
        }),
      );
    });

    it('sets a non-secure cookie in development', async () => {
      // Arrange
      mockService.activateDevice.mockResolvedValue({
        deviceUid: 'device-1',
        secret: 'plain-secret',
      });
      const mockReq = { body: { activationCode: 'ABCD1234' } };

      // Act
      await controller.activateDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockSetCookie).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ secure: false }),
      );
    });

    it('sets a secure cookie outside of development', async () => {
      // Arrange
      const prodController = new DeviceManagementController(
        { isDevelopment: false } as never,
        mockService as never,
        mockDeviceAuthService as never,
      );
      mockService.activateDevice.mockResolvedValue({
        deviceUid: 'device-1',
        secret: 'plain-secret',
      });
      const mockReq = { body: { activationCode: 'ABCD1234' } };

      // Act
      await prodController.activateDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockSetCookie).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ secure: true }),
      );
    });

    it('sends the deviceUid on success', async () => {
      // Arrange
      mockService.activateDevice.mockResolvedValue({
        deviceUid: 'device-1',
        secret: 'plain-secret',
      });
      const mockReq = { body: { activationCode: 'ABCD1234' } };

      // Act
      await controller.activateDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith({ deviceUid: 'device-1' });
    });
  });

  describe('updateDevice', (it) => {
    it("throws 404 when service returns 'DEVICE_NOT_FOUND'", async () => {
      // Arrange
      mockService.updateDevice.mockResolvedValue('DEVICE_NOT_FOUND');
      const mockReq = { body: { deviceUid: 'device-1', name: 'New Name' } };

      // Act + Assert
      await expect(
        controller.updateDevice(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 404, code: 'DEVICE_NOT_FOUND' });
    });

    it('serializes createdAt to ISO string', async () => {
      // Arrange
      mockService.updateDevice.mockResolvedValue({
        ...mockDevice,
        name: 'New Name',
      });
      const mockReq = { body: { deviceUid: 'device-1', name: 'New Name' } };

      // Act
      await controller.updateDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ createdAt: FAKE_DATE.toISOString() }),
      );
    });

    it('strips deviceUid from the update payload sent to the service', async () => {
      // Arrange
      mockService.updateDevice.mockResolvedValue(mockDevice);
      const mockReq = { body: { deviceUid: 'device-1', name: 'New Name' } };

      // Act
      await controller.updateDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.updateDevice).toHaveBeenCalledWith('device-1', {
        name: 'New Name',
      });
    });
  });

  describe('deleteDevice', (it) => {
    it('calls the service with the deviceUid from the body', async () => {
      // Arrange
      mockService.deleteDevice.mockResolvedValue(undefined);
      const mockReq = { body: { deviceUid: 'device-1' } };

      // Act
      await controller.deleteDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.deleteDevice).toHaveBeenCalledWith('device-1');
    });

    it("throws 404 when service returns 'DEVICE_NOT_FOUND'", async () => {
      // Arrange
      mockService.deleteDevice.mockResolvedValue('DEVICE_NOT_FOUND');
      const mockReq = { body: { deviceUid: 'device-1' } };

      // Act + Assert
      await expect(
        controller.deleteDevice(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 404, code: 'DEVICE_NOT_FOUND' });
    });

    it("throws 409 when service returns 'WOULD_LEAVE_ROOM_WITHOUT_SOURCE'", async () => {
      // Arrange
      mockService.deleteDevice.mockResolvedValue(
        'WOULD_LEAVE_ROOM_WITHOUT_SOURCE',
      );
      const mockReq = { body: { deviceUid: 'device-1' } };

      // Act + Assert
      await expect(
        controller.deleteDevice(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'WOULD_LEAVE_ROOM_WITHOUT_SOURCE',
      });
    });

    it('sends 204 with null on success', async () => {
      // Arrange
      mockService.deleteDevice.mockResolvedValue(undefined);
      const mockReq = { body: { deviceUid: 'device-1' } };

      // Act
      await controller.deleteDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(204);
      expect(mockSend).toHaveBeenCalledWith(null);
    });
  });

  describe('getMyDevice', (it) => {
    it('calls the service with the deviceUid from the request', async () => {
      // Arrange
      mockService.getMyDevice.mockResolvedValue({
        uid: 'device-1',
        name: 'Test Device',
        roomUid: null,
        isSource: null,
      });
      const mockReq = { deviceUid: 'device-1' };

      // Act
      await controller.getMyDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.getMyDevice).toHaveBeenCalledWith('device-1');
    });

    it('throws 500 when deviceUid is not present on the request', async () => {
      // Arrange
      const mockReq = { deviceUid: undefined };

      // Act + Assert
      await expect(
        controller.getMyDevice(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 500 });
    });

    it("throws 404 when service returns 'DEVICE_NOT_FOUND'", async () => {
      // Arrange
      mockService.getMyDevice.mockResolvedValue('DEVICE_NOT_FOUND');
      const mockReq = { deviceUid: 'device-1' };

      // Act + Assert
      await expect(
        controller.getMyDevice(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 404, code: 'DEVICE_NOT_FOUND' });
    });

    it('passes the service result through unchanged', async () => {
      // Arrange
      const myDevice = {
        uid: 'device-1',
        name: 'Test Device',
        roomUid: 'room-1',
        isSource: true,
      };
      mockService.getMyDevice.mockResolvedValue(myDevice);
      const mockReq = { deviceUid: 'device-1' };

      // Act
      await controller.getMyDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith(myDevice);
    });
  });
});
