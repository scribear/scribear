import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { RoomManagementService } from '#src/server/features/room-management/room-management.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

const VALID_TIMEZONE = 'America/New_York';
const INVALID_TIMEZONE = 'Not/A/Timezone';

const mockRoom = {
  uid: 'room-1',
  name: 'Test Room',
  timezone: VALID_TIMEZONE,
  roomScheduleVersion: 1,
  createdAt: '2025-01-01T00:00:00.000Z',
};

const mockDevice = {
  uid: 'device-1',
  name: 'Test Device',
  active: true,
  createdAt: '2025-01-01T00:00:00.000Z',
  roomUid: null,
  isSource: null,
};

describe('RoomManagementService', () => {
  let mockRoomRepo: {
    findById: Mock;
    list: Mock;
    create: Mock;
    update: Mock;
    delete: Mock;
    addDeviceToRoom: Mock;
    removeDeviceFromRoom: Mock;
    setSourceDevice: Mock;
    findRoomMembership: Mock;
    findRoomExists: Mock;
  };
  let mockDeviceRepo: { findById: Mock };
  let service: RoomManagementService;

  beforeEach(() => {
    mockRoomRepo = {
      findById: vi.fn(),
      list: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      addDeviceToRoom: vi.fn(),
      removeDeviceFromRoom: vi.fn(),
      setSourceDevice: vi.fn(),
      findRoomMembership: vi.fn(),
      findRoomExists: vi.fn(),
    };
    mockDeviceRepo = { findById: vi.fn() };

    service = new RoomManagementService(
      createMockLogger() as never,
      mockRoomRepo as never,
      mockDeviceRepo as never,
    );
  });

  describe('listRooms', (it) => {
    it('delegates to the repository with the provided params', async () => {
      // Arrange
      mockRoomRepo.list.mockResolvedValue({ items: [], nextCursor: null });
      const params = { search: 'conf', cursor: 'abc', limit: 20 };

      // Act
      const result = await service.listRooms(params);

      // Assert
      expect(mockRoomRepo.list).toHaveBeenCalledWith(params);
      expect(result).toStrictEqual({ items: [], nextCursor: null });
    });
  });

  describe('getRoom', (it) => {
    it('calls findById with the roomUid', async () => {
      // Arrange
      mockRoomRepo.findById.mockResolvedValue(mockRoom);

      // Act
      await service.getRoom('room-1');

      // Assert
      expect(mockRoomRepo.findById).toHaveBeenCalledWith('room-1');
    });

    it("returns 'ROOM_NOT_FOUND' when the room does not exist", async () => {
      // Arrange
      mockRoomRepo.findById.mockResolvedValue(undefined);

      // Act
      const result = await service.getRoom('room-1');

      // Assert
      expect(result).toBe('ROOM_NOT_FOUND');
    });

    it('returns the room when found', async () => {
      // Arrange
      mockRoomRepo.findById.mockResolvedValue(mockRoom);

      // Act
      const result = await service.getRoom('room-1');

      // Assert
      expect(result).toStrictEqual(mockRoom);
    });
  });

  describe('createRoom', (it) => {
    it("returns 'INVALID_TIMEZONE' for an unknown timezone", async () => {
      // Arrange / Act
      const result = await service.createRoom({
        name: 'Room',
        timezone: INVALID_TIMEZONE,
        sourceDeviceUids: ['device-1'],
        autoSessionEnabled: true,
      });

      // Assert
      expect(result).toBe('INVALID_TIMEZONE');
    });

    it("returns 'TOO_MANY_SOURCE_DEVICES' when more than one source device is provided", async () => {
      // Arrange / Act
      const result = await service.createRoom({
        name: 'Room',
        timezone: VALID_TIMEZONE,
        sourceDeviceUids: ['device-1', 'device-2'],
        autoSessionEnabled: true,
      });

      // Assert
      expect(result).toBe('TOO_MANY_SOURCE_DEVICES');
    });

    it("returns 'NO_SOURCE_DEVICE' when no source device is provided", async () => {
      // Arrange / Act
      const result = await service.createRoom({
        name: 'Room',
        timezone: VALID_TIMEZONE,
        sourceDeviceUids: [],
        autoSessionEnabled: true,
      });

      // Assert
      expect(result).toBe('NO_SOURCE_DEVICE');
    });

    it("returns 'DEVICE_NOT_FOUND' when the source device does not exist", async () => {
      // Arrange
      mockDeviceRepo.findById.mockResolvedValue(undefined);

      // Act
      const result = await service.createRoom({
        name: 'Room',
        timezone: VALID_TIMEZONE,
        sourceDeviceUids: ['device-1'],
        autoSessionEnabled: true,
      });

      // Assert
      expect(result).toBe('DEVICE_NOT_FOUND');
    });

    it("returns 'DEVICE_ALREADY_IN_ROOM' when the source device is already in a room", async () => {
      // Arrange
      mockDeviceRepo.findById.mockResolvedValue({
        ...mockDevice,
        roomUid: 'other-room',
      });

      // Act
      const result = await service.createRoom({
        name: 'Room',
        timezone: VALID_TIMEZONE,
        sourceDeviceUids: ['device-1'],
        autoSessionEnabled: true,
      });

      // Assert
      expect(result).toBe('DEVICE_ALREADY_IN_ROOM');
    });

    it('calls deviceRepo.findById with the source device uid', async () => {
      // Arrange
      mockDeviceRepo.findById.mockResolvedValue(mockDevice);
      mockRoomRepo.create.mockResolvedValue(mockRoom);
      mockRoomRepo.addDeviceToRoom.mockResolvedValue(undefined);

      // Act
      await service.createRoom({
        name: 'Room',
        timezone: VALID_TIMEZONE,
        sourceDeviceUids: ['device-1'],
        autoSessionEnabled: true,
      });

      // Assert
      expect(mockDeviceRepo.findById).toHaveBeenCalledWith('device-1');
    });

    it('calls repo.create with the correct name and timezone', async () => {
      // Arrange
      mockDeviceRepo.findById.mockResolvedValue(mockDevice);
      mockRoomRepo.create.mockResolvedValue(mockRoom);
      mockRoomRepo.addDeviceToRoom.mockResolvedValue(undefined);

      // Act
      await service.createRoom({
        name: 'Test Room',
        timezone: VALID_TIMEZONE,
        sourceDeviceUids: ['device-1'],
        autoSessionEnabled: true,
      });

      // Assert
      expect(mockRoomRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Test Room',
          timezone: VALID_TIMEZONE,
        }),
      );
    });

    it('creates the room and adds the source device on success', async () => {
      // Arrange
      mockDeviceRepo.findById.mockResolvedValue(mockDevice);
      mockRoomRepo.create.mockResolvedValue(mockRoom);
      mockRoomRepo.addDeviceToRoom.mockResolvedValue(undefined);

      // Act
      const result = await service.createRoom({
        name: 'Test Room',
        timezone: VALID_TIMEZONE,
        sourceDeviceUids: ['device-1'],
        autoSessionEnabled: true,
      });

      // Assert
      expect(result).toStrictEqual(mockRoom);
      expect(mockRoomRepo.addDeviceToRoom).toHaveBeenCalledWith(
        mockRoom.uid,
        'device-1',
        true,
      );
    });
  });

  describe('updateRoom', (it) => {
    it('calls repo.update with the roomUid and update data', async () => {
      // Arrange
      mockRoomRepo.update.mockResolvedValue(mockRoom);

      // Act
      await service.updateRoom('room-1', { name: 'New Name' });

      // Assert
      expect(mockRoomRepo.update).toHaveBeenCalledWith('room-1', {
        name: 'New Name',
      });
    });

    it("returns 'ROOM_NOT_FOUND' when the room does not exist", async () => {
      // Arrange
      mockRoomRepo.update.mockResolvedValue(undefined);

      // Act
      const result = await service.updateRoom('room-1', { name: 'New Name' });

      // Assert
      expect(result).toBe('ROOM_NOT_FOUND');
    });

    it('returns the updated room on success', async () => {
      // Arrange
      mockRoomRepo.update.mockResolvedValue(mockRoom);

      // Act
      const result = await service.updateRoom('room-1', { name: 'New Name' });

      // Assert
      expect(result).toStrictEqual(mockRoom);
    });
  });

  describe('deleteRoom', (it) => {
    it('calls repo.delete with the roomUid', async () => {
      // Arrange
      mockRoomRepo.delete.mockResolvedValue(true);

      // Act
      await service.deleteRoom('room-1');

      // Assert
      expect(mockRoomRepo.delete).toHaveBeenCalledWith('room-1');
    });

    it("returns 'ROOM_NOT_FOUND' when the room does not exist", async () => {
      // Arrange
      mockRoomRepo.delete.mockResolvedValue(false);

      // Act
      const result = await service.deleteRoom('room-1');

      // Assert
      expect(result).toBe('ROOM_NOT_FOUND');
    });

    it('returns undefined on success', async () => {
      // Arrange
      mockRoomRepo.delete.mockResolvedValue(true);

      // Act
      const result = await service.deleteRoom('room-1');

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('addDeviceToRoom', (it) => {
    it("returns 'ROOM_NOT_FOUND' when the room does not exist", async () => {
      // Arrange
      mockRoomRepo.findRoomExists.mockResolvedValue(false);
      mockDeviceRepo.findById.mockResolvedValue(mockDevice);

      // Act
      const result = await service.addDeviceToRoom({
        roomUid: 'room-1',
        deviceUid: 'device-1',
        asSource: false,
      });

      // Assert
      expect(result).toBe('ROOM_NOT_FOUND');
    });

    it("returns 'DEVICE_NOT_FOUND' when the device does not exist", async () => {
      // Arrange
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockDeviceRepo.findById.mockResolvedValue(undefined);

      // Act
      const result = await service.addDeviceToRoom({
        roomUid: 'room-1',
        deviceUid: 'device-1',
        asSource: false,
      });

      // Assert
      expect(result).toBe('DEVICE_NOT_FOUND');
    });

    it("returns 'DEVICE_ALREADY_IN_ROOM' when the device is already in a room", async () => {
      // Arrange
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockDeviceRepo.findById.mockResolvedValue({
        ...mockDevice,
        roomUid: 'other-room',
      });

      // Act
      const result = await service.addDeviceToRoom({
        roomUid: 'room-1',
        deviceUid: 'device-1',
        asSource: false,
      });

      // Assert
      expect(result).toBe('DEVICE_ALREADY_IN_ROOM');
    });

    it('calls repo.addDeviceToRoom with the correct args on success', async () => {
      // Arrange
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockDeviceRepo.findById.mockResolvedValue(mockDevice);
      mockRoomRepo.addDeviceToRoom.mockResolvedValue(undefined);

      // Act
      await service.addDeviceToRoom({
        roomUid: 'room-1',
        deviceUid: 'device-1',
        asSource: true,
      });

      // Assert
      expect(mockRoomRepo.addDeviceToRoom).toHaveBeenCalledWith(
        'room-1',
        'device-1',
        true,
      );
    });

    it('returns undefined on success', async () => {
      // Arrange
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockDeviceRepo.findById.mockResolvedValue(mockDevice);
      mockRoomRepo.addDeviceToRoom.mockResolvedValue(undefined);

      // Act
      const result = await service.addDeviceToRoom({
        roomUid: 'room-1',
        deviceUid: 'device-1',
        asSource: false,
      });

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('removeDeviceFromRoom', (it) => {
    it("returns 'MEMBERSHIP_NOT_FOUND' when the device is not in any room", async () => {
      // Arrange
      mockRoomRepo.findRoomMembership.mockResolvedValue(undefined);

      // Act
      const result = await service.removeDeviceFromRoom('device-1');

      // Assert
      expect(result).toBe('MEMBERSHIP_NOT_FOUND');
    });

    it("returns 'WOULD_LEAVE_ROOM_WITHOUT_SOURCE' when the device is the room's source", async () => {
      // Arrange
      mockRoomRepo.findRoomMembership.mockResolvedValue({
        room_uid: 'room-1',
        is_source: true,
      });

      // Act
      const result = await service.removeDeviceFromRoom('device-1');

      // Assert
      expect(result).toBe('WOULD_LEAVE_ROOM_WITHOUT_SOURCE');
      expect(mockRoomRepo.removeDeviceFromRoom).not.toHaveBeenCalled();
    });

    it('calls repo.removeDeviceFromRoom with the deviceUid on success', async () => {
      // Arrange
      mockRoomRepo.findRoomMembership.mockResolvedValue({
        room_uid: 'room-1',
        is_source: false,
      });
      mockRoomRepo.removeDeviceFromRoom.mockResolvedValue(true);

      // Act
      await service.removeDeviceFromRoom('device-1');

      // Assert
      expect(mockRoomRepo.removeDeviceFromRoom).toHaveBeenCalledWith(
        'device-1',
      );
    });

    it('returns undefined on success', async () => {
      // Arrange
      mockRoomRepo.findRoomMembership.mockResolvedValue({
        room_uid: 'room-1',
        is_source: false,
      });
      mockRoomRepo.removeDeviceFromRoom.mockResolvedValue(true);

      // Act
      const result = await service.removeDeviceFromRoom('device-1');

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('setSourceDevice', (it) => {
    it("returns 'ROOM_NOT_FOUND' when the room does not exist", async () => {
      // Arrange
      mockRoomRepo.findRoomExists.mockResolvedValue(false);

      // Act
      const result = await service.setSourceDevice('room-1', 'device-1');

      // Assert
      expect(result).toBe('ROOM_NOT_FOUND');
    });

    it("returns 'DEVICE_NOT_IN_ROOM' when the device is not a member of the room", async () => {
      // Arrange
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockRoomRepo.setSourceDevice.mockResolvedValue(false);

      // Act
      const result = await service.setSourceDevice('room-1', 'device-1');

      // Assert
      expect(result).toBe('DEVICE_NOT_IN_ROOM');
    });

    it('calls repo.setSourceDevice with the correct args on success', async () => {
      // Arrange
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockRoomRepo.setSourceDevice.mockResolvedValue(true);

      // Act
      await service.setSourceDevice('room-1', 'device-1');

      // Assert
      expect(mockRoomRepo.setSourceDevice).toHaveBeenCalledWith(
        'room-1',
        'device-1',
      );
    });

    it('returns undefined on success', async () => {
      // Arrange
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockRoomRepo.setSourceDevice.mockResolvedValue(true);

      // Act
      const result = await service.setSourceDevice('room-1', 'device-1');

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('getMyRoom', (it) => {
    it('calls findRoomMembership with the deviceUid', async () => {
      // Arrange
      mockRoomRepo.findRoomMembership.mockResolvedValue(undefined);

      // Act
      await service.getMyRoom('device-1');

      // Assert
      expect(mockRoomRepo.findRoomMembership).toHaveBeenCalledWith('device-1');
    });

    it('calls findById with the room_uid from the membership', async () => {
      // Arrange
      mockRoomRepo.findRoomMembership.mockResolvedValue({
        room_uid: 'room-1',
        is_source: false,
      });
      mockRoomRepo.findById.mockResolvedValue(mockRoom);

      // Act
      await service.getMyRoom('device-1');

      // Assert
      expect(mockRoomRepo.findById).toHaveBeenCalledWith('room-1');
    });

    it("returns 'DEVICE_NOT_IN_ROOM' when the device has no room membership", async () => {
      // Arrange
      mockRoomRepo.findRoomMembership.mockResolvedValue(undefined);

      // Act
      const result = await service.getMyRoom('device-1');

      // Assert
      expect(result).toBe('DEVICE_NOT_IN_ROOM');
    });

    it("returns 'DEVICE_NOT_IN_ROOM' when the membership's room no longer exists", async () => {
      // Arrange
      mockRoomRepo.findRoomMembership.mockResolvedValue({
        room_uid: 'room-1',
        is_source: false,
      });
      mockRoomRepo.findById.mockResolvedValue(undefined);

      // Act
      const result = await service.getMyRoom('device-1');

      // Assert
      expect(result).toBe('DEVICE_NOT_IN_ROOM');
    });

    it('returns a subset of room fields on success', async () => {
      // Arrange
      mockRoomRepo.findRoomMembership.mockResolvedValue({
        uid: 'room-1',
        name: 'Test Room',
        timezone: VALID_TIMEZONE,
        roomScheduleVersion: 1,
        createdAt: '2025-01-01T00:00:00.000Z',
      });
      mockRoomRepo.findById.mockResolvedValue(mockRoom);

      // Act
      const result = await service.getMyRoom('device-1');

      // Assert
      expect(result).toStrictEqual({
        uid: 'room-1',
        name: 'Test Room',
        timezone: VALID_TIMEZONE,
        roomScheduleVersion: 1,
      });
    });
  });
});
