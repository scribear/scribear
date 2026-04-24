import { describe, expect } from 'vitest';

import { HashService } from '#src/server/shared/services/hash.service.js';

describe('HashService', () => {
  const service = new HashService();

  describe('hash / verify', (it) => {
    it('produces a hash that verifies against the original value', async () => {
      // Arrange
      const value = 'my-secret';

      // Act
      const hash = await service.hash(value);
      const result = await service.verify(value, hash);

      // Assert
      expect(result).toBe(true);
    });

    it('returns false when the value does not match the hash', async () => {
      // Arrange
      const hash = await service.hash('correct-value');

      // Act
      const result = await service.verify('wrong-value', hash);

      // Assert
      expect(result).toBe(false);
    });

    it('produces distinct hashes for the same input on successive calls', async () => {
      // Arrange
      const value = 'same-value';

      // Act
      const hash1 = await service.hash(value);
      const hash2 = await service.hash(value);

      // Assert
      expect(hash1).not.toBe(hash2);
    });
  });
});
