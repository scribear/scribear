import { describe, expect } from 'vitest';

import { ServiceAuthService } from '#src/server/shared/services/service-auth.service.js';

const TEST_API_KEY = 'test-service-key';

describe('ServiceAuthService', () => {
  const service = new ServiceAuthService({ serviceApiKey: TEST_API_KEY });

  describe('isValid', (it) => {
    it('returns true for a valid Bearer token', () => {
      // Arrange / Act
      const result = service.isValid(`Bearer ${TEST_API_KEY}`);

      // Assert
      expect(result).toBe(true);
    });

    it('returns false for an incorrect key', () => {
      // Arrange / Act
      const result = service.isValid('Bearer wrong-key');

      // Assert
      expect(result).toBe(false);
    });

    it('returns false when the Bearer prefix is missing', () => {
      // Arrange / Act
      const result = service.isValid(TEST_API_KEY);

      // Assert
      expect(result).toBe(false);
    });

    it('returns false for undefined', () => {
      // Arrange / Act
      const result = service.isValid(undefined);

      // Assert
      expect(result).toBe(false);
    });

    it('returns false for an empty string', () => {
      // Arrange / Act
      const result = service.isValid('');

      // Assert
      expect(result).toBe(false);
    });
  });
});
