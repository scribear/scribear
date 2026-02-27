import { type Mock, afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { DeviceManagementService } from '#src/server/features/device-management/device-management.service.js';

import { createMockLogger } from '../../../../utils/mock-logger.js';

const ACTIVATION_CODE_PATTERN = /^[A-Z0-9]{8}$/;
const TEST_DEVICE_ID = 'test-device-id';
const TEST_SECRET_HASH = 'x'.repeat(60);
const FAKE_NOW = new Date('2025-01-01T00:00:00Z');

describe('DeviceManagementService', (it) => {
  let mockRepository: {
    createInactiveDevice: Mock;
    findDeviceByActivationCode: Mock;
    activateDevice: Mock;
  };
  let mockHashService: { hash: Mock };
  let service: DeviceManagementService;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FAKE_NOW);

    mockRepository = {
      createInactiveDevice: vi.fn(),
      findDeviceByActivationCode: vi.fn(),
      activateDevice: vi.fn(),
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

  describe('registerDevice', (it) => {
    it('creates an inactive device and returns deviceId and activationCode', async () => {
      // Arrange
      mockRepository.createInactiveDevice.mockResolvedValue({ id: TEST_DEVICE_ID });

      // Act
      const result = await service.registerDevice('my-device');

      // Assert
      expect(mockRepository.createInactiveDevice).toHaveBeenCalledExactlyOnceWith(
        'my-device',
        expect.stringMatching(ACTIVATION_CODE_PATTERN),
        expect.any(Date),
      );
      expect(result).toEqual({
        deviceId: TEST_DEVICE_ID,
        activationCode: expect.stringMatching(ACTIVATION_CODE_PATTERN),
      });
    });

    it('sets activation expiry 5 minutes in the future', async () => {
      // Arrange
      mockRepository.createInactiveDevice.mockResolvedValue({ id: TEST_DEVICE_ID });

      // Act
      await service.registerDevice('my-device');

      // Assert
      const [, , expiry] = mockRepository.createInactiveDevice.mock.calls[0] as [string, string, Date];
      expect(expiry).toEqual(new Date(FAKE_NOW.getTime() + 5 * 60 * 1000));
    });
  });

  describe('activateDevice', (it) => {
    it('returns null when activation code is not found', async () => {
      // Arrange
      mockRepository.findDeviceByActivationCode.mockResolvedValue(undefined);

      // Act
      const result = await service.activateDevice('ABCD1234');

      // Assert
      expect(result).toBeNull();
      expect(mockRepository.activateDevice).not.toHaveBeenCalled();
    });

    it('returns null when device is already active', async () => {
      // Arrange
      mockRepository.findDeviceByActivationCode.mockResolvedValue({
        id: TEST_DEVICE_ID,
        is_active: true,
        activation_expiry: new Date(FAKE_NOW.getTime() + 60_000),
      });

      // Act
      const result = await service.activateDevice('ABCD1234');

      // Assert
      expect(result).toBeNull();
      expect(mockRepository.activateDevice).not.toHaveBeenCalled();
    });

    it('returns null when device has no activation expiry', async () => {
      // Arrange
      mockRepository.findDeviceByActivationCode.mockResolvedValue({
        id: TEST_DEVICE_ID,
        is_active: false,
        activation_expiry: null,
      });

      // Act
      const result = await service.activateDevice('ABCD1234');

      // Assert
      expect(result).toBeNull();
      expect(mockRepository.activateDevice).not.toHaveBeenCalled();
    });

    it('returns null when activation code is expired', async () => {
      // Arrange
      mockRepository.findDeviceByActivationCode.mockResolvedValue({
        id: TEST_DEVICE_ID,
        is_active: false,
        activation_expiry: new Date(FAKE_NOW.getTime() - 1),
      });

      // Act
      const result = await service.activateDevice('ABCD1234');

      // Assert
      expect(result).toBeNull();
      expect(mockRepository.activateDevice).not.toHaveBeenCalled();
    });

    it('returns deviceId, deviceName, and deviceSecret on success', async () => {
      // Arrange
      mockRepository.findDeviceByActivationCode.mockResolvedValue({
        id: TEST_DEVICE_ID,
        is_active: false,
        activation_expiry: new Date(FAKE_NOW.getTime() + 1),
      });
      mockHashService.hash.mockResolvedValue(TEST_SECRET_HASH);
      mockRepository.activateDevice.mockResolvedValue({
        id: TEST_DEVICE_ID,
        name: 'my-device',
      });

      // Act
      const result = await service.activateDevice('ABCD1234');

      // Assert
      expect(mockHashService.hash).toHaveBeenCalledOnce();
      expect(mockRepository.activateDevice).toHaveBeenCalledExactlyOnceWith(
        'ABCD1234',
        TEST_SECRET_HASH,
      );
      expect(result).toEqual({
        deviceId: TEST_DEVICE_ID,
        deviceName: 'my-device',
        deviceSecret: expect.any(String),
      });
    });

    it('stores the hash of the generated secret, not the secret itself', async () => {
      // Arrange
      mockRepository.findDeviceByActivationCode.mockResolvedValue({
        id: TEST_DEVICE_ID,
        is_active: false,
        activation_expiry: new Date(FAKE_NOW.getTime() + 60_000),
      });
      mockHashService.hash.mockResolvedValue(TEST_SECRET_HASH);
      mockRepository.activateDevice.mockResolvedValue({
        id: TEST_DEVICE_ID,
        name: 'my-device',
      });

      // Act
      const result = await service.activateDevice('ABCD1234');

      // Assert
      const [plainSecret] = mockHashService.hash.mock.calls[0] as [string];
      expect(result?.deviceSecret).toBe(plainSecret);
      expect(mockRepository.activateDevice).toHaveBeenCalledWith('ABCD1234', TEST_SECRET_HASH);
    });
  });
});
