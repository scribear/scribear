import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { AuthService } from '#src/server/services/auth.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

describe('AuthService', () => {
  const TEST_API_KEY = 'TEST_API_KEY';

  let mockAuthRepository: { findDeviceHash: Mock };
  let mockHashService: { verify: Mock };
  let authService: AuthService;

  beforeEach(() => {
    mockAuthRepository = { findDeviceHash: vi.fn() };
    mockHashService = { verify: vi.fn() };

    authService = new AuthService(
      createMockLogger() as never,
      { apiKey: TEST_API_KEY },
      mockAuthRepository as never,
      mockHashService as never,
    );
  });

  describe('isValidApiKey', (it) => {
    it('returns true for a valid Bearer token', () => {
      // Arrange / Act
      const result = authService.isValidApiKey(`Bearer ${TEST_API_KEY}`);

      // Assert
      expect(result).toBe(true);
    });

    it('returns false when header is undefined', () => {
      // Arrange / Act
      const result = authService.isValidApiKey(undefined);

      // Assert
      expect(result).toBe(false);
    });

    it('returns false when Bearer prefix is missing', () => {
      // Arrange / Act
      const result = authService.isValidApiKey(TEST_API_KEY);

      // Assert
      expect(result).toBe(false);
    });

    it('returns false for an incorrect key', () => {
      // Arrange / Act
      const result = authService.isValidApiKey('Bearer WRONG_KEY');

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('encodeDeviceToken', (it) => {
    it('encodes deviceId and secret with separator', () => {
      // Arrange / Act
      const result = authService.encodeDeviceToken('device-1', 'mysecret');

      // Assert
      expect(result).toBe('device-1:mysecret');
    });
  });

  describe('decodeDeviceToken', (it) => {
    it('decodes a valid token into deviceId and secret', () => {
      // Arrange / Act
      const result = authService.decodeDeviceToken('device-1:mysecret');

      // Assert
      expect(result).toEqual({ deviceId: 'device-1', secret: 'mysecret' });
    });

    it('handles a secret that contains a colon', () => {
      // Arrange / Act
      const result = authService.decodeDeviceToken(
        'device-1:secret:with:colons',
      );

      // Assert
      expect(result).toEqual({
        deviceId: 'device-1',
        secret: 'secret:with:colons',
      });
    });

    it('returns null when separator is missing', () => {
      // Arrange / Act
      const result = authService.decodeDeviceToken('noseparator');

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('verifyDeviceToken', (it) => {
    it('returns deviceId when token is valid', async () => {
      // Arrange
      mockAuthRepository.findDeviceHash.mockResolvedValue({
        id: 'device-1',
        secret_hash: 'HASH',
      });
      mockHashService.verify.mockResolvedValue(true);

      // Act
      const result = await authService.verifyDeviceToken('device-1:mysecret');

      // Assert
      expect(mockHashService.verify).toHaveBeenCalledExactlyOnceWith(
        'mysecret',
        'HASH',
      );
      expect(result).toEqual({ deviceId: 'device-1' });
    });

    it('returns null when token has no separator', async () => {
      // Arrange / Act
      const result = await authService.verifyDeviceToken('noseparator');

      // Assert
      expect(result).toBeNull();
      expect(mockAuthRepository.findDeviceHash).not.toHaveBeenCalled();
    });

    it('returns null when device is not found', async () => {
      // Arrange
      mockAuthRepository.findDeviceHash.mockResolvedValue(undefined);

      // Act
      const result = await authService.verifyDeviceToken('device-1:mysecret');

      // Assert
      expect(result).toBeNull();
      expect(mockHashService.verify).not.toHaveBeenCalled();
    });

    it('returns null when device has no secret hash', async () => {
      // Arrange
      mockAuthRepository.findDeviceHash.mockResolvedValue({
        id: 'device-1',
        secret_hash: null,
      });

      // Act
      const result = await authService.verifyDeviceToken('device-1:mysecret');

      // Assert
      expect(result).toBeNull();
      expect(mockHashService.verify).not.toHaveBeenCalled();
    });

    it('returns null when secret does not match hash', async () => {
      // Arrange
      mockAuthRepository.findDeviceHash.mockResolvedValue({
        id: 'device-1',
        secret_hash: 'HASH',
      });
      mockHashService.verify.mockResolvedValue(false);

      // Act
      const result = await authService.verifyDeviceToken(
        'device-1:wrongsecret',
      );

      // Assert
      expect(result).toBeNull();
    });
  });
});
