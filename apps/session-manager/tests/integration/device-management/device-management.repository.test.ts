import { beforeEach, describe, expect } from 'vitest';

import { DeviceManagementRepository } from '#src/server/features/device-management/device-management.repository.js';

import { useDb } from '../../utils/use-db.js';

const TEST_ACTIVATION_CODE = 'ABCD1234';
const TEST_SECRET_HASH = 'x'.repeat(60);
const FUTURE_DATE = new Date(Date.now() + 1000 * 60 * 60);

describe('DeviceManagementRepository', (it) => {
  const dbContext = useDb(['devices']);
  let repository: DeviceManagementRepository;

  beforeEach(() => {
    repository = new DeviceManagementRepository(dbContext.dbClient);
  });

  describe('findDeviceByActivationCode', (it) => {
    it('returns device fields when activation code exists', async () => {
      // Arrange
      await dbContext.db
        .insertInto('devices')
        .values({
          name: 'test-device',
          activation_code: TEST_ACTIVATION_CODE,
          activation_expiry: FUTURE_DATE,
        })
        .execute();

      // Act
      const result =
        await repository.findDeviceByActivationCode(TEST_ACTIVATION_CODE);

      // Assert
      expect(result).toMatchObject({
        name: 'test-device',
        is_active: false,
        activation_expiry: expect.any(Date),
      });
      expect(result?.id).toBeDefined();
    });

    it('returns undefined when activation code does not exist', async () => {
      // Arrange / Act
      const result = await repository.findDeviceByActivationCode('NOTFOUND');

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('createInactiveDevice', (it) => {
    it('inserts a new inactive device and returns its id', async () => {
      // Arrange / Act
      const result = await repository.createInactiveDevice(
        'my-device',
        TEST_ACTIVATION_CODE,
        FUTURE_DATE,
      );

      // Assert
      expect(result.id).toBeDefined();

      const inserted = await dbContext.db
        .selectFrom('devices')
        .selectAll()
        .where('id', '=', result.id)
        .executeTakeFirstOrThrow();

      expect(inserted.name).toBe('my-device');
      expect(inserted.activation_code).toBe(TEST_ACTIVATION_CODE);
      expect(inserted.is_active).toBe(false);
      expect(inserted.secret_hash).toBeNull();
    });
  });

  describe('activateDevice', (it) => {
    it('activates an inactive device and returns id and name', async () => {
      // Arrange
      await dbContext.db
        .insertInto('devices')
        .values({
          name: 'pending-device',
          activation_code: TEST_ACTIVATION_CODE,
          activation_expiry: FUTURE_DATE,
        })
        .execute();

      // Act
      const result = await repository.activateDevice(
        TEST_ACTIVATION_CODE,
        TEST_SECRET_HASH,
      );

      // Assert
      expect(result).toEqual({
        id: expect.any(String),
        name: 'pending-device',
      });

      const updated = await dbContext.db
        .selectFrom('devices')
        .selectAll()
        .where('id', '=', result.id)
        .executeTakeFirstOrThrow();

      expect(updated.is_active).toBe(true);
      expect(updated.secret_hash).toBe(TEST_SECRET_HASH);
      expect(updated.activation_code).toBeNull();
      expect(updated.activation_expiry).toBeNull();
    });

    it('throws when activation code does not exist', async () => {
      // Act & Assert
      await expect(
        repository.activateDevice('NOTFOUND', TEST_SECRET_HASH),
      ).rejects.toThrow();
    });

    it('throws when device is already active', async () => {
      // Arrange
      await dbContext.db
        .insertInto('devices')
        .values({
          name: 'active-device',
          activation_code: TEST_ACTIVATION_CODE,
          is_active: true,
          secret_hash: TEST_SECRET_HASH,
        })
        .execute();

      // Act / Assert
      await expect(
        repository.activateDevice(TEST_ACTIVATION_CODE, TEST_SECRET_HASH),
      ).rejects.toThrow();
    });
  });
});
