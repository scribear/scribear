import { beforeEach, describe, expect } from 'vitest';

import { DeviceManagementRepository } from '#src/server/features/device-management/device-management.repository.js';
import { useDb } from '#tests/utils/use-db.js';

const TEST_CODE = 'TESTCODE';
const TEST_HASH = 'x'.repeat(60);
const FUTURE_EXPIRY = new Date(Date.now() + 60 * 60 * 1000);

describe('DeviceManagementRepository', () => {
  const dbContext = useDb(['rooms', 'devices']);
  let repository: DeviceManagementRepository;

  beforeEach(() => {
    repository = new DeviceManagementRepository(dbContext.dbClient);
  });

  describe('create', (it) => {
    it('inserts a device and returns uid and name', async () => {
      // Arrange / Act
      const result = await repository.create({
        name: 'My Device',
        activationCode: TEST_CODE,
        expiry: FUTURE_EXPIRY,
      });

      // Assert
      expect(result.uid).toBeDefined();
      expect(result.name).toBe('My Device');
    });
  });

  describe('findById', (it) => {
    it('returns the device with null room fields when not in a room', async () => {
      // Arrange
      const { uid } = await dbContext.db
        .insertInto('devices')
        .values({
          name: 'standalone',
          activation_code: TEST_CODE,
          expiry: FUTURE_EXPIRY,
        })
        .returning('uid')
        .executeTakeFirstOrThrow();

      // Act
      const result = await repository.findById(uid);

      // Assert
      expect(result).toMatchObject({
        uid,
        name: 'standalone',
        active: false,
        roomUid: null,
        isSource: null,
      });
    });

    it('returns the device with room fields when in a room as source', async () => {
      // Arrange
      const { uid: roomUid } = await dbContext.db
        .insertInto('rooms')
        .values({ name: 'Room', timezone: 'UTC' })
        .returning('uid')
        .executeTakeFirstOrThrow();

      const { uid: deviceUid } = await dbContext.db
        .insertInto('devices')
        .values({ name: 'source-device', hash: TEST_HASH, active: true })
        .returning('uid')
        .executeTakeFirstOrThrow();

      await dbContext.db
        .insertInto('room_devices')
        .values({ room_uid: roomUid, device_uid: deviceUid, is_source: true })
        .execute();

      // Act
      const result = await repository.findById(deviceUid);

      // Assert
      expect(result).toMatchObject({ uid: deviceUid, roomUid, isSource: true });
    });

    it('returns undefined when the device does not exist', async () => {
      // Arrange / Act
      const result = await repository.findById(
        '00000000-0000-0000-0000-000000000000',
      );

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('findByActivationCode', (it) => {
    it('returns the device row when the code exists', async () => {
      // Arrange
      await dbContext.db
        .insertInto('devices')
        .values({
          name: 'pending',
          activation_code: TEST_CODE,
          expiry: FUTURE_EXPIRY,
        })
        .execute();

      // Act
      const result = await repository.findByActivationCode(TEST_CODE);

      // Assert
      expect(result).toMatchObject({
        name: 'pending',
        expiry: expect.any(Date),
      });
    });

    it('returns undefined when the code does not exist', async () => {
      // Arrange / Act
      const result = await repository.findByActivationCode('NOTFOUND');

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('activate', (it) => {
    it('activates the device and clears the activation code and expiry', async () => {
      // Arrange
      await dbContext.db
        .insertInto('devices')
        .values({
          name: 'pending',
          activation_code: TEST_CODE,
          expiry: FUTURE_EXPIRY,
        })
        .execute();

      // Act
      const result = await repository.activate(TEST_CODE, TEST_HASH);

      // Assert
      expect(result).toMatchObject({ name: 'pending' });
      const row = await dbContext.db
        .selectFrom('devices')
        .selectAll()
        .where('uid', '=', result!.uid)
        .executeTakeFirstOrThrow();
      expect(row.active).toBe(true);
      expect(row.hash).toBe(TEST_HASH);
      expect(row.activation_code).toBeNull();
      expect(row.expiry).toBeNull();
    });

    it('returns undefined when the code does not exist', async () => {
      // Arrange / Act
      const result = await repository.activate('NOTFOUND', TEST_HASH);

      // Assert
      expect(result).toBeUndefined();
    });

    it('returns undefined when the device is already active (prevents double-activation)', async () => {
      // Arrange - activate a device so its code is consumed
      await dbContext.db
        .insertInto('devices')
        .values({ name: 'pending', activation_code: TEST_CODE, expiry: FUTURE_EXPIRY })
        .execute();
      await repository.activate(TEST_CODE, TEST_HASH);

      // Act - attempt to activate the same code again
      const result = await repository.activate(TEST_CODE, TEST_HASH);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('reregister', (it) => {
    it('resets the device to unactivated state with a new code', async () => {
      // Arrange
      const { uid } = await dbContext.db
        .insertInto('devices')
        .values({ name: 'active', hash: TEST_HASH, active: true })
        .returning('uid')
        .executeTakeFirstOrThrow();

      // Act
      const result = await repository.reregister(
        uid,
        'NEWCODE1',
        FUTURE_EXPIRY,
      );

      // Assert
      expect(result).toMatchObject({ uid, activation_code: 'NEWCODE1' });
      const row = await dbContext.db
        .selectFrom('devices')
        .selectAll()
        .where('uid', '=', uid)
        .executeTakeFirstOrThrow();
      expect(row.active).toBe(false);
      expect(row.hash).toBeNull();
    });

    it('returns undefined when the device does not exist', async () => {
      // Arrange / Act
      const result = await repository.reregister(
        '00000000-0000-0000-0000-000000000000',
        'NEWCODE1',
        FUTURE_EXPIRY,
      );

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('update', (it) => {
    it('updates the device name and returns the device with room fields', async () => {
      // Arrange
      const { uid } = await dbContext.db
        .insertInto('devices')
        .values({ name: 'old-name', hash: TEST_HASH, active: true })
        .returning('uid')
        .executeTakeFirstOrThrow();

      // Act
      const result = await repository.update(uid, { name: 'new-name' });

      // Assert
      expect(result).toMatchObject({ uid, name: 'new-name', roomUid: null });
    });

    it('returns the current state when no name is provided', async () => {
      // Arrange
      const { uid } = await dbContext.db
        .insertInto('devices')
        .values({ name: 'my-device', hash: TEST_HASH, active: true })
        .returning('uid')
        .executeTakeFirstOrThrow();

      // Act
      const result = await repository.update(uid, {});

      // Assert
      expect(result).toMatchObject({ uid, name: 'my-device' });
    });

    it('returns undefined when the device does not exist', async () => {
      // Arrange / Act
      const result = await repository.update(
        '00000000-0000-0000-0000-000000000000',
        { name: 'new-name' },
      );

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('delete', (it) => {
    it('deletes the device and returns true', async () => {
      // Arrange
      const { uid } = await dbContext.db
        .insertInto('devices')
        .values({
          name: 'to-delete',
          activation_code: TEST_CODE,
          expiry: FUTURE_EXPIRY,
        })
        .returning('uid')
        .executeTakeFirstOrThrow();

      // Act
      const result = await repository.delete(uid);

      // Assert
      expect(result).toBe(true);
      const row = await dbContext.db
        .selectFrom('devices')
        .select('uid')
        .where('uid', '=', uid)
        .executeTakeFirst();
      expect(row).toBeUndefined();
    });

    it('returns false when the device does not exist', async () => {
      // Arrange / Act
      const result = await repository.delete(
        '00000000-0000-0000-0000-000000000000',
      );

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('list', (it) => {
    it('returns all devices ordered by created_at and uid', async () => {
      // Arrange
      await dbContext.db
        .insertInto('devices')
        .values([
          {
            name: 'device-a',
            activation_code: 'CODE0001',
            expiry: FUTURE_EXPIRY,
          },
          {
            name: 'device-b',
            activation_code: 'CODE0002',
            expiry: FUTURE_EXPIRY,
          },
        ])
        .execute();

      // Act
      const result = await repository.list({ limit: 50 });

      // Assert
      expect(result.items).toHaveLength(2);
      expect(result.nextCursor).toBeUndefined();
    });

    it('returns a nextCursor when there are more results than the limit', async () => {
      // Arrange
      await dbContext.db
        .insertInto('devices')
        .values([
          {
            name: 'device-a',
            activation_code: 'CODE0001',
            expiry: FUTURE_EXPIRY,
          },
          {
            name: 'device-b',
            activation_code: 'CODE0002',
            expiry: FUTURE_EXPIRY,
          },
        ])
        .execute();

      // Act
      const result = await repository.list({ limit: 1 });

      // Assert
      expect(result.items).toHaveLength(1);
      expect(result.nextCursor).toBeDefined();
    });

    it('filters by active status', async () => {
      // Arrange
      await dbContext.db
        .insertInto('devices')
        .values([
          { name: 'active', hash: TEST_HASH, active: true },
          {
            name: 'inactive',
            activation_code: 'CODE0001',
            expiry: FUTURE_EXPIRY,
          },
        ])
        .execute();

      // Act
      const result = await repository.list({ active: true, limit: 50 });

      // Assert
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.name).toBe('active');
    });

    it("returns devices not in any room when roomUid is ''", async () => {
      // Arrange
      const { uid: roomUid } = await dbContext.db
        .insertInto('rooms')
        .values({ name: 'Room', timezone: 'UTC' })
        .returning('uid')
        .executeTakeFirstOrThrow();

      const { uid: inRoomUid } = await dbContext.db
        .insertInto('devices')
        .values({ name: 'in-room', hash: TEST_HASH, active: true })
        .returning('uid')
        .executeTakeFirstOrThrow();

      await dbContext.db
        .insertInto('room_devices')
        .values({ room_uid: roomUid, device_uid: inRoomUid, is_source: true })
        .execute();

      await dbContext.db
        .insertInto('devices')
        .values({
          name: 'no-room',
          activation_code: 'CODE0001',
          expiry: FUTURE_EXPIRY,
        })
        .execute();

      // Act
      const result = await repository.list({ roomUid: '', limit: 50 });

      // Assert
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.name).toBe('no-room');
    });
  });
});
