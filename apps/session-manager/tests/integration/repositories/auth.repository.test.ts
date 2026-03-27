import { beforeEach, describe, expect } from 'vitest';

import { AuthRepository } from '#src/server/repositories/auth.repository.js';
import { useDb } from '#tests/utils/use-db.js';

const TEST_HASH = 'x'.repeat(60);

describe('AuthRepository', () => {
  const dbContext = useDb(['devices']);
  let authRepository: AuthRepository;

  beforeEach(() => {
    authRepository = new AuthRepository(dbContext.dbClient);
  });

  describe('findDeviceHash', (it) => {
    it('returns id and secret_hash for an existing device', async () => {
      // Arrange
      const inserted = await dbContext.db
        .insertInto('devices')
        .values({ name: 'test-device', secret_hash: TEST_HASH })
        .returning(['id', 'secret_hash'])
        .executeTakeFirstOrThrow();

      // Act
      const result = await authRepository.findDeviceHash(inserted.id);

      // Assert
      expect(result).toEqual({ id: inserted.id, secret_hash: TEST_HASH });
    });

    it('returns null secret_hash when device has no secret_hash', async () => {
      // Arrange
      const inserted = await dbContext.db
        .insertInto('devices')
        .values({ name: 'test-device' })
        .returning(['id'])
        .executeTakeFirstOrThrow();

      // Act
      const result = await authRepository.findDeviceHash(inserted.id);

      // Assert
      expect(result).toEqual({ id: inserted.id, secret_hash: null });
    });

    it('returns undefined when device does not exist', async () => {
      // Arrange
      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      // Act
      const result = await authRepository.findDeviceHash(nonExistentId);

      // Assert
      expect(result).toBeUndefined();
    });
  });
});
