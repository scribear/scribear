import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { DeviceAuthService } from '#src/server/shared/services/device-auth.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

describe('DeviceAuthService', () => {
  let mockRepository: { findDeviceHash: Mock };
  let mockHashService: { verify: Mock };
  let service: DeviceAuthService;

  beforeEach(() => {
    mockRepository = { findDeviceHash: vi.fn() };
    mockHashService = { verify: vi.fn() };
    service = new DeviceAuthService(
      createMockLogger() as never,
      mockRepository as never,
      mockHashService as never,
    );
  });

  describe('encode / decode', (it) => {
    it('round-trips a deviceUid and secret', () => {
      // Arrange
      const deviceUid = 'device-1';
      const secret = 'my-secret';

      // Act
      const token = service.encode(deviceUid, secret);
      const decoded = service.decode(token);

      // Assert
      expect(decoded).toStrictEqual({ deviceUid, secret });
    });

    it('decode returns null when the separator is missing', () => {
      // Arrange / Act
      const result = service.decode('no-separator-here');

      // Assert
      expect(result).toBeNull();
    });

    it('decode handles a secret that contains the separator character', () => {
      // Arrange
      const deviceUid = 'device-1';
      const secret = 'sec:ret:with:colons';

      // Act
      const token = service.encode(deviceUid, secret);
      const decoded = service.decode(token);

      // Assert
      expect(decoded).toStrictEqual({ deviceUid, secret });
    });
  });

  describe('verify', (it) => {
    it('returns null when the token cannot be decoded', async () => {
      // Arrange / Act
      const result = await service.verify('no-separator-here');

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when the device is not found', async () => {
      // Arrange
      mockRepository.findDeviceHash.mockResolvedValue(undefined);
      const token = service.encode('device-1', 'secret');

      // Act
      const result = await service.verify(token);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when the device hash is not set (not yet activated)', async () => {
      // Arrange
      mockRepository.findDeviceHash.mockResolvedValue({
        uid: 'device-1',
        hash: null,
      });
      const token = service.encode('device-1', 'secret');

      // Act
      const result = await service.verify(token);

      // Assert
      expect(result).toBeNull();
    });

    it('returns null when the secret does not match the stored hash', async () => {
      // Arrange
      mockRepository.findDeviceHash.mockResolvedValue({
        uid: 'device-1',
        hash: 'stored-hash',
      });
      mockHashService.verify.mockResolvedValue(false);
      const token = service.encode('device-1', 'wrong-secret');

      // Act
      const result = await service.verify(token);

      // Assert
      expect(result).toBeNull();
    });

    it('returns the deviceUid when the token is valid', async () => {
      // Arrange
      mockRepository.findDeviceHash.mockResolvedValue({
        uid: 'device-1',
        hash: 'stored-hash',
      });
      mockHashService.verify.mockResolvedValue(true);
      const token = service.encode('device-1', 'correct-secret');

      // Act
      const result = await service.verify(token);

      // Assert
      expect(result).toStrictEqual({ deviceUid: 'device-1' });
    });
  });
});
