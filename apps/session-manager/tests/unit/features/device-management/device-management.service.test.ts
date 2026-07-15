import { type Mock, afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { DeviceManagementService } from '#src/server/features/device-management/device-management.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

const FAKE_NOW = new Date('2025-01-01T00:00:00Z');
const FUTURE_EXPIRY = new Date(FAKE_NOW.getTime() + 5 * 60 * 1000);

describe('DeviceManagementService', () => {
  let mockRepository: {
    findById: Mock;
    list: Mock;
    create: Mock;
    findByActivationCode: Mock;
    activate: Mock;
    reregister: Mock;
    update: Mock;
    delete: Mock;
  };
  let mockHashService: { hash: Mock };
  let service: DeviceManagementService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FAKE_NOW);

    mockRepository = {
      findById: vi.fn(),
      list: vi.fn(),
      create: vi.fn(),
      findByActivationCode: vi.fn(),
      activate: vi.fn(),
      reregister: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    mockHashService = { hash: vi.fn() };

    service = new DeviceManagementService(
      createMockLogger() as never,
      mockRepository as never,
      mockHashService as never,
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('listDevices', (it) => {
    it('calls list with the provided params', async () => {
      // Arrange
      const params = {
        search: 'test',
        active: true,
        roomUid: null,
        cursor: null,
        limit: 10,
      };
      mockRepository.list.mockResolvedValue({ items: [], nextCursor: null });

      // Act
      await service.listDevices(params);

      // Assert
      expect(mockRepository.list).toHaveBeenCalledWith(params);
    });
  });

  describe('getDevice', (it) => {
    it('calls findById with the deviceUid', async () => {
      // Arrange
      mockRepository.findById.mockResolvedValue({ uid: 'device-1' });

      // Act
      await service.getDevice('device-1');

      // Assert
      expect(mockRepository.findById).toHaveBeenCalledWith('device-1');
    });

    it("returns 'DEVICE_NOT_FOUND' when the device does not exist", async () => {
      // Arrange
      mockRepository.findById.mockResolvedValue(undefined);

      // Act
      const result = await service.getDevice('device-1');

      // Assert
      expect(result).toBe('DEVICE_NOT_FOUND');
    });

    it('returns the device when found', async () => {
      // Arrange
      const device = {
        uid: 'device-1',
        name: 'Test',
        active: true,
        createdAt: '2025-01-01T00:00:00.000Z',
        roomUid: null,
        isSource: null,
      };
      mockRepository.findById.mockResolvedValue(device);

      // Act
      const result = await service.getDevice('device-1');

      // Assert
      expect(result).toStrictEqual(device);
    });
  });

  describe('registerDevice', (it) => {
    it('creates a device and returns deviceUid, activationCode, and expiry', async () => {
      // Arrange
      mockRepository.create.mockResolvedValue({
        uid: 'device-1',
        name: 'Test',
      });

      // Act
      const result = await service.registerDevice('Test');

      // Assert
      expect(result).toMatchObject({
        deviceUid: 'device-1',
        activationCode: expect.any(String),
        expiry: FUTURE_EXPIRY,
      });
    });

    it('sets the activation expiry 5 minutes in the future', async () => {
      // Arrange
      mockRepository.create.mockResolvedValue({
        uid: 'device-1',
        name: 'Test',
      });

      // Act
      await service.registerDevice('Test');

      // Assert
      const callArg = mockRepository.create.mock.calls[0]?.[0] as {
        expiry: Date;
      };
      expect(callArg.expiry).toEqual(FUTURE_EXPIRY);
    });

    it('calls create with the device name and an 8-character activation code', async () => {
      // Arrange
      mockRepository.create.mockResolvedValue({
        uid: 'device-1',
        name: 'Test',
      });

      // Act
      await service.registerDevice('Test');

      // Assert
      const [callArg] = mockRepository.create.mock.calls[0] as [
        { name: string; activationCode: string; expiry: Date },
      ];
      expect(callArg.name).toBe('Test');
      expect(callArg.activationCode).toHaveLength(8);
    });
  });

  describe('reregisterDevice', (it) => {
    it("returns 'DEVICE_NOT_FOUND' when the device does not exist", async () => {
      // Arrange
      mockRepository.findById.mockResolvedValue(undefined);

      // Act
      const result = await service.reregisterDevice('device-1');

      // Assert
      expect(result).toBe('DEVICE_NOT_FOUND');
    });

    it("returns 'DEVICE_NOT_FOUND' when reregister returns undefined (race condition)", async () => {
      // Arrange
      mockRepository.findById.mockResolvedValue({ uid: 'device-1' });
      mockRepository.reregister.mockResolvedValue(undefined);

      // Act
      const result = await service.reregisterDevice('device-1');

      // Assert
      expect(result).toBe('DEVICE_NOT_FOUND');
    });

    it('returns activationCode and expiry on success', async () => {
      // Arrange
      mockRepository.findById.mockResolvedValue({ uid: 'device-1' });
      mockRepository.reregister.mockResolvedValue({
        uid: 'device-1',
        activation_code: 'ABCD1234',
        expiry: FUTURE_EXPIRY.toISOString(),
      });

      // Act
      const result = await service.reregisterDevice('device-1');

      // Assert
      expect(result).toStrictEqual({
        activationCode: 'ABCD1234',
        expiry: FUTURE_EXPIRY.toISOString(),
      });
    });

    it('sets the activation expiry 5 minutes in the future', async () => {
      // Arrange
      mockRepository.findById.mockResolvedValue({ uid: 'device-1' });
      mockRepository.reregister.mockResolvedValue({
        uid: 'device-1',
        activation_code: 'ABCD1234',
        expiry: FUTURE_EXPIRY.toISOString(),
      });

      // Act
      await service.reregisterDevice('device-1');

      // Assert
      const [, , expiry] = mockRepository.reregister.mock.calls[0] as [
        unknown,
        unknown,
        Date,
      ];
      expect(expiry).toEqual(FUTURE_EXPIRY);
    });

    it('calls reregister with the deviceUid and an 8-character activation code', async () => {
      // Arrange
      mockRepository.findById.mockResolvedValue({ uid: 'device-1' });
      mockRepository.reregister.mockResolvedValue({
        uid: 'device-1',
        activation_code: 'ABCD1234',
        expiry: FUTURE_EXPIRY.toISOString(),
      });

      // Act
      await service.reregisterDevice('device-1');

      // Assert
      const [deviceUid, activationCode] = mockRepository.reregister.mock
        .calls[0] as [string, string, Date];
      expect(deviceUid).toBe('device-1');
      expect(activationCode).toHaveLength(8);
    });
  });

  describe('activateDevice', (it) => {
    it('calls findByActivationCode with the activation code', async () => {
      // Arrange
      mockRepository.findByActivationCode.mockResolvedValue(undefined);

      // Act
      await service.activateDevice('ABCD1234');

      // Assert
      expect(mockRepository.findByActivationCode).toHaveBeenCalledWith(
        'ABCD1234',
      );
    });

    it("returns 'ACTIVATION_CODE_NOT_FOUND' when the code does not exist", async () => {
      // Arrange
      mockRepository.findByActivationCode.mockResolvedValue(undefined);

      // Act
      const result = await service.activateDevice('ABCD1234');

      // Assert
      expect(result).toBe('ACTIVATION_CODE_NOT_FOUND');
    });

    it("returns 'ACTIVATION_CODE_EXPIRED' when the code has no expiry", async () => {
      // Arrange
      mockRepository.findByActivationCode.mockResolvedValue({
        uid: 'device-1',
        expiry: null,
      });

      // Act
      const result = await service.activateDevice('ABCD1234');

      // Assert
      expect(result).toBe('ACTIVATION_CODE_EXPIRED');
    });

    it("returns 'ACTIVATION_CODE_EXPIRED' when the code is past its expiry", async () => {
      // Arrange
      mockRepository.findByActivationCode.mockResolvedValue({
        uid: 'device-1',
        expiry: new Date(FAKE_NOW.getTime() - 1),
      });

      // Act
      const result = await service.activateDevice('ABCD1234');

      // Assert
      expect(result).toBe('ACTIVATION_CODE_EXPIRED');
    });

    it("returns 'ACTIVATION_CODE_NOT_FOUND' when activate returns undefined (race condition)", async () => {
      // Arrange
      mockRepository.findByActivationCode.mockResolvedValue({
        uid: 'device-1',
        expiry: new Date(FAKE_NOW.getTime() + 60_000),
      });
      mockHashService.hash.mockResolvedValue('hashed');
      mockRepository.activate.mockResolvedValue(undefined);

      // Act
      const result = await service.activateDevice('ABCD1234');

      // Assert
      expect(result).toBe('ACTIVATION_CODE_NOT_FOUND');
    });

    it('returns deviceUid and secret on success', async () => {
      // Arrange
      mockRepository.findByActivationCode.mockResolvedValue({
        uid: 'device-1',
        expiry: new Date(FAKE_NOW.getTime() + 60_000),
      });
      mockHashService.hash.mockResolvedValue('hashed');
      mockRepository.activate.mockResolvedValue({
        uid: 'device-1',
        name: 'Test',
      });

      // Act
      const result = await service.activateDevice('ABCD1234');

      // Assert
      expect(result).toMatchObject({
        deviceUid: 'device-1',
        secret: expect.any(String),
      });
    });

    it('stores the hash of the generated secret, not the secret itself', async () => {
      // Arrange
      mockRepository.findByActivationCode.mockResolvedValue({
        uid: 'device-1',
        expiry: new Date(FAKE_NOW.getTime() + 60_000),
      });
      mockHashService.hash.mockResolvedValue('hashed-secret');
      mockRepository.activate.mockResolvedValue({
        uid: 'device-1',
        name: 'Test',
      });

      // Act
      const result = await service.activateDevice('ABCD1234');

      // Assert
      expect(mockRepository.activate).toHaveBeenCalledWith(
        'ABCD1234',
        'hashed-secret',
      );
      const [plainSecret] = mockHashService.hash.mock.calls[0] as [string];
      expect(result).toMatchObject({ secret: plainSecret });
    });
  });

  describe('updateDevice', (it) => {
    it("returns 'DEVICE_NOT_FOUND' when the device does not exist", async () => {
      // Arrange
      mockRepository.update.mockResolvedValue(undefined);

      // Act
      const result = await service.updateDevice('device-1', {
        name: 'New Name',
      });

      // Assert
      expect(result).toBe('DEVICE_NOT_FOUND');
    });

    it('returns the updated device on success', async () => {
      // Arrange
      const device = {
        uid: 'device-1',
        name: 'New Name',
        active: true,
        createdAt: '2025-01-01T00:00:00.000Z',
        roomUid: null,
        isSource: null,
      };
      mockRepository.update.mockResolvedValue(device);

      // Act
      const result = await service.updateDevice('device-1', {
        name: 'New Name',
      });

      // Assert
      expect(result).toStrictEqual(device);
    });

    it('calls update with the deviceUid and data', async () => {
      // Arrange
      mockRepository.update.mockResolvedValue({ uid: 'device-1' });

      // Act
      await service.updateDevice('device-1', { name: 'New Name' });

      // Assert
      expect(mockRepository.update).toHaveBeenCalledWith('device-1', {
        name: 'New Name',
      });
    });
  });

  describe('deleteDevice', (it) => {
    it("returns 'DEVICE_NOT_FOUND' when the device does not exist", async () => {
      // Arrange
      mockRepository.findById.mockResolvedValue(undefined);

      // Act
      const result = await service.deleteDevice('device-1');

      // Assert
      expect(result).toBe('DEVICE_NOT_FOUND');
    });

    it("returns 'WOULD_LEAVE_ROOM_WITHOUT_SOURCE' when the device is the room's source", async () => {
      // Arrange
      mockRepository.findById.mockResolvedValue({
        uid: 'device-1',
        isSource: true,
        roomUid: 'room-1',
      });

      // Act
      const result = await service.deleteDevice('device-1');

      // Assert
      expect(result).toBe('WOULD_LEAVE_ROOM_WITHOUT_SOURCE');
      expect(mockRepository.delete).not.toHaveBeenCalled();
    });

    it("returns 'DEVICE_NOT_FOUND' when delete returns false (race condition)", async () => {
      // Arrange
      mockRepository.findById.mockResolvedValue({
        uid: 'device-1',
        isSource: false,
        roomUid: null,
      });
      mockRepository.delete.mockResolvedValue(false);

      // Act
      const result = await service.deleteDevice('device-1');

      // Assert
      expect(result).toBe('DEVICE_NOT_FOUND');
    });

    it('returns undefined on success', async () => {
      // Arrange
      mockRepository.findById.mockResolvedValue({
        uid: 'device-1',
        isSource: false,
        roomUid: null,
      });
      mockRepository.delete.mockResolvedValue(true);

      // Act
      const result = await service.deleteDevice('device-1');

      // Assert
      expect(result).toBeUndefined();
    });

    it('calls delete with the deviceUid', async () => {
      // Arrange
      mockRepository.findById.mockResolvedValue({
        uid: 'device-1',
        isSource: false,
        roomUid: null,
      });
      mockRepository.delete.mockResolvedValue(true);

      // Act
      await service.deleteDevice('device-1');

      // Assert
      expect(mockRepository.delete).toHaveBeenCalledWith('device-1');
    });
  });

  describe('getMyDevice', (it) => {
    it('calls findById with the deviceUid', async () => {
      // Arrange
      mockRepository.findById.mockResolvedValue({
        uid: 'device-1',
        name: 'Test',
        active: true,
        createdAt: '2025-01-01T00:00:00.000Z',
        roomUid: null,
        isSource: false,
      });

      // Act
      await service.getMyDevice('device-1');

      // Assert
      expect(mockRepository.findById).toHaveBeenCalledWith('device-1');
    });

    it("returns 'DEVICE_NOT_FOUND' when the device does not exist", async () => {
      // Arrange
      mockRepository.findById.mockResolvedValue(undefined);

      // Act
      const result = await service.getMyDevice('device-1');

      // Assert
      expect(result).toBe('DEVICE_NOT_FOUND');
    });

    it('returns a subset of device fields on success', async () => {
      // Arrange
      mockRepository.findById.mockResolvedValue({
        uid: 'device-1',
        name: 'Test',
        active: true,
        createdAt: '2025-01-01T00:00:00.000Z',
        roomUid: 'room-1',
        isSource: true,
      });

      // Act
      const result = await service.getMyDevice('device-1');

      // Assert
      expect(result).toStrictEqual({
        uid: 'device-1',
        name: 'Test',
        roomUid: 'room-1',
        isSource: true,
      });
    });
  });
});
