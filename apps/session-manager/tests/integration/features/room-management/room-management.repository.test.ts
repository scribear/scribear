import { beforeEach, describe, expect } from 'vitest';

import { RoomManagementRepository } from '#src/server/features/room-management/room-management.repository.js';
import { useDb } from '#tests/utils/use-db.js';

const TEST_HASH = 'x'.repeat(60);

describe('RoomManagementRepository', () => {
  const dbContext = useDb(['rooms', 'devices']);
  let repository: RoomManagementRepository;

  beforeEach(() => {
    repository = new RoomManagementRepository(dbContext.dbClient);
  });

  async function insertRoom(name = 'Test Room', timezone = 'UTC') {
    return dbContext.db
      .insertInto('rooms')
      .values({ name, timezone })
      .returning('uid')
      .executeTakeFirstOrThrow();
  }

  async function insertDevice(name = 'Test Device') {
    return dbContext.db
      .insertInto('devices')
      .values({ name, hash: TEST_HASH, active: true })
      .returning('uid')
      .executeTakeFirstOrThrow();
  }

  describe('create', (it) => {
    it('inserts a room and returns its mapped fields', async () => {
      // Arrange / Act
      const result = await repository.create({
        name: 'My Room',
        timezone: 'America/New_York',
        autoSessionEnabled: false,
      });

      // Assert
      expect(result.uid).toBeDefined();
      expect(result.name).toBe('My Room');
      expect(result.timezone).toBe('America/New_York');
      expect(result.autoSessionEnabled).toBe(false);
      expect(result.roomScheduleVersion).toBe(0);
    });
  });

  describe('findById', (it) => {
    it('returns the mapped room when found', async () => {
      // Arrange
      const { uid } = await insertRoom('Room A');

      // Act
      const result = await repository.findById(uid);

      // Assert
      expect(result).toMatchObject({ uid, name: 'Room A' });
    });

    it('returns undefined when the room does not exist', async () => {
      // Arrange / Act
      const result = await repository.findById(
        '00000000-0000-0000-0000-000000000000',
      );

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('update', (it) => {
    it('updates the specified fields and returns the room', async () => {
      // Arrange
      const { uid } = await insertRoom('Old Name');

      // Act
      const result = await repository.update(uid, { name: 'New Name' });

      // Assert
      expect(result).toMatchObject({ uid, name: 'New Name' });
    });

    it('returns the current state via findById when no fields are provided', async () => {
      // Arrange
      const { uid } = await insertRoom('Unchanged');

      // Act
      const result = await repository.update(uid, {});

      // Assert
      expect(result).toMatchObject({ uid, name: 'Unchanged' });
    });

    it('returns undefined when the room does not exist', async () => {
      // Arrange / Act
      const result = await repository.update(
        '00000000-0000-0000-0000-000000000000',
        { name: 'X' },
      );

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('delete', (it) => {
    it('deletes the room and returns true', async () => {
      // Arrange
      const { uid } = await insertRoom();

      // Act
      const result = await repository.delete(uid);

      // Assert
      expect(result).toBe(true);
      expect(await repository.findById(uid)).toBeUndefined();
    });

    it('returns false when the room does not exist', async () => {
      // Arrange / Act
      const result = await repository.delete(
        '00000000-0000-0000-0000-000000000000',
      );

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('list', (it) => {
    it('returns all rooms ordered by created_at and uid', async () => {
      // Arrange
      await insertRoom('Room A');
      await insertRoom('Room B');

      // Act
      const result = await repository.list({ limit: 50 });

      // Assert
      expect(result.items).toHaveLength(2);
      expect(result.nextCursor).toBeUndefined();
    });

    it('returns a nextCursor when there are more results than the limit', async () => {
      // Arrange
      await insertRoom('Room A');
      await insertRoom('Room B');

      // Act
      const result = await repository.list({ limit: 1 });

      // Assert
      expect(result.items).toHaveLength(1);
      expect(result.nextCursor).toBeDefined();
    });

    it('filters by search term (case-insensitive)', async () => {
      // Arrange
      await insertRoom('Alpha Room');
      await insertRoom('Beta Room');

      // Act
      const result = await repository.list({ search: 'alpha', limit: 50 });

      // Assert
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.name).toBe('Alpha Room');
    });
  });

  describe('addDeviceToRoom', (it) => {
    it('adds a device as a non-source member', async () => {
      // Arrange - room must have a source before a non-source can be added
      const { uid: roomUid } = await insertRoom();
      const { uid: sourceUid } = await insertDevice('Source');
      await repository.addDeviceToRoom(roomUid, sourceUid, true);
      const { uid: deviceUid } = await insertDevice('Member');

      // Act
      await repository.addDeviceToRoom(roomUid, deviceUid, false);

      // Assert
      const row = await dbContext.db
        .selectFrom('room_devices')
        .selectAll()
        .where('device_uid', '=', deviceUid)
        .executeTakeFirst();
      expect(row).toMatchObject({ room_uid: roomUid, is_source: false });
    });

    it('adds a device as source and clears any previous source', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      const { uid: firstUid } = await insertDevice('First');
      const { uid: secondUid } = await insertDevice('Second');

      await repository.addDeviceToRoom(roomUid, firstUid, true);

      // Act
      await repository.addDeviceToRoom(roomUid, secondUid, true);

      // Assert
      const rows = await dbContext.db
        .selectFrom('room_devices')
        .selectAll()
        .where('room_uid', '=', roomUid)
        .execute();
      const first = rows.find((r) => r.device_uid === firstUid);
      const second = rows.find((r) => r.device_uid === secondUid);
      expect(first?.is_source).toBe(false);
      expect(second?.is_source).toBe(true);
    });
  });

  describe('removeDeviceFromRoom', (it) => {
    it('removes the device and returns true', async () => {
      // Arrange - room has a source; the member being removed is non-source
      const { uid: roomUid } = await insertRoom();
      const { uid: sourceUid } = await insertDevice('Source');
      await repository.addDeviceToRoom(roomUid, sourceUid, true);
      const { uid: deviceUid } = await insertDevice('Member');
      await repository.addDeviceToRoom(roomUid, deviceUid, false);

      // Act
      const result = await repository.removeDeviceFromRoom(deviceUid);

      // Assert
      expect(result).toBe(true);
      const row = await dbContext.db
        .selectFrom('room_devices')
        .select('device_uid')
        .where('device_uid', '=', deviceUid)
        .executeTakeFirst();
      expect(row).toBeUndefined();
    });

    it('returns false when the device is not in any room', async () => {
      // Arrange
      const { uid: deviceUid } = await insertDevice();

      // Act
      const result = await repository.removeDeviceFromRoom(deviceUid);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('setSourceDevice', (it) => {
    it('promotes the target device to source and demotes all others', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      const { uid: firstUid } = await insertDevice('First');
      const { uid: secondUid } = await insertDevice('Second');
      await repository.addDeviceToRoom(roomUid, firstUid, true);
      await repository.addDeviceToRoom(roomUid, secondUid, false);

      // Act
      const result = await repository.setSourceDevice(roomUid, secondUid);

      // Assert
      expect(result).toBe(true);
      const rows = await dbContext.db
        .selectFrom('room_devices')
        .selectAll()
        .where('room_uid', '=', roomUid)
        .execute();
      const first = rows.find((r) => r.device_uid === firstUid);
      const second = rows.find((r) => r.device_uid === secondUid);
      expect(first?.is_source).toBe(false);
      expect(second?.is_source).toBe(true);
    });

    it('returns false when the device is not a member of the room', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      const { uid: deviceUid } = await insertDevice();

      // Act
      const result = await repository.setSourceDevice(roomUid, deviceUid);

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('findRoomMembership', (it) => {
    it('returns membership details when the device is in a room', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      const { uid: deviceUid } = await insertDevice();
      await repository.addDeviceToRoom(roomUid, deviceUid, true);

      // Act
      const result = await repository.findRoomMembership(deviceUid);

      // Assert
      expect(result).toStrictEqual({ room_uid: roomUid, is_source: true });
    });

    it('returns undefined when the device is not in any room', async () => {
      // Arrange
      const { uid: deviceUid } = await insertDevice();

      // Act
      const result = await repository.findRoomMembership(deviceUid);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('findRoomExists', (it) => {
    it('returns true when the room exists', async () => {
      // Arrange
      const { uid } = await insertRoom();

      // Act
      const result = await repository.findRoomExists(uid);

      // Assert
      expect(result).toBe(true);
    });

    it('returns false when the room does not exist', async () => {
      // Arrange / Act
      const result = await repository.findRoomExists(
        '00000000-0000-0000-0000-000000000000',
      );

      // Assert
      expect(result).toBe(false);
    });
  });
});
