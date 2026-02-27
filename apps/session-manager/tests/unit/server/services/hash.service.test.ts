import { beforeEach, describe, expect } from 'vitest';

import { HashService } from '#src/server/services/hash.service.js';

describe('HashService', (it) => {
  let hashService: HashService;

  beforeEach(() => {
    hashService = new HashService();
  });

  it('hashes a value', async () => {
    // Arrange
    const value = 'plaintext';

    // Act
    const hash = await hashService.hash(value);

    // Assert
    expect(hash).not.toBe(value);
    expect(hash).toMatch(/^\$2b\$/);
  });

  it('produces different hashes for the same value', async () => {
    // Arrange
    const value = 'plaintext';

    // Act
    const hash1 = await hashService.hash(value);
    const hash2 = await hashService.hash(value);

    // Assert
    expect(hash1).not.toBe(hash2);
  });

  it('verifies a correct value against its hash', async () => {
    // Arrange
    const value = 'plaintext';
    const hash = await hashService.hash(value);

    // Act
    const result = await hashService.verify(value, hash);

    // Assert
    expect(result).toBe(true);
  });

  it('rejects an incorrect value against a hash', async () => {
    // Arrange
    const hash = await hashService.hash('plaintext');

    // Act
    const result = await hashService.verify('wrongvalue', hash);

    // Assert
    expect(result).toBe(false);
  });
});
