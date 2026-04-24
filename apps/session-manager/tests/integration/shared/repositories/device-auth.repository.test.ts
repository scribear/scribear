import { beforeEach, describe, expect } from 'vitest';

import { DeviceAuthRepository } from '#src/server/shared/repositories/device-auth.repository.js';
import { useDb } from '#tests/utils/use-db.js';

const TEST_HASH = 'x'.repeat(60);

describe('DeviceAuthRepository', () => {
  const dbContext = useDb(['devices']);
  let repository: DeviceAuthRepository;

  beforeEach(() => {
    repository = new DeviceAuthRepository(dbContext.dbClient);
  });

  describe('findDeviceHash', (it) => {
    it('returns uid and hash for an activated device', async () => {
      // Arrange
      const { uid } = await dbContext.db
        .insertInto('devices')
        .values({ name: 'test-device', hash: TEST_HASH, active: true })
        .returning('uid')
        .executeTakeFirstOrThrow();

      // Act
      const result = await repository.findDeviceHash(uid);

      // Assert
      expect(result).toStrictEqual({ uid, hash: TEST_HASH });
    });

    it('returns null hash for a device that has not yet been activated', async () => {
      // Arrange
      const { uid } = await dbContext.db
        .insertInto('devices')
        .values({
          name: 'pending-device',
          activation_code: 'ABCD1234',
          expiry: new Date(Date.now() + 60_000),
        })
        .returning('uid')
        .executeTakeFirstOrThrow();

      // Act
      const result = await repository.findDeviceHash(uid);

      // Assert
      expect(result).toStrictEqual({ uid, hash: null });
    });

    it('returns undefined when the device does not exist', async () => {
      // Arrange / Act
      const result = await repository.findDeviceHash(
        '00000000-0000-0000-0000-000000000000',
      );

      // Assert
      expect(result).toBeUndefined();
    });
  });
});
