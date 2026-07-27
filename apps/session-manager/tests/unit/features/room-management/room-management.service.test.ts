import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import {
  CANARY_DEVICE_UID,
  CANARY_ROOM_UID,
} from '#src/server/features/canary-room/canary-room.constants.js';
import {
  DEMO_ROOM_UID,
  DEMO_SOURCE_DEVICE_UID,
} from '#src/server/features/demo-room/demo-room.constants.js';
import { RoomManagementService } from '#src/server/features/room-management/room-management.service.js';
import {
  TEST_AUDIO_GOOD_DEVICE_UID,
  TEST_AUDIO_GOOD_ROOM_UID,
} from '#src/server/features/test-audio-rooms/test-audio-rooms.constants.js';
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

  /**
   * The demo caption room emits a fixture caption stream and has no audio path,
   * so attaching a device to it (or making one its source) can never work. The
   * guard keys off the two uids the seeder reserves; every other room/device uid
   * is generated by the database, so the paired "ordinary" cases below are the
   * ones that matter most — a guard that over-matched would break every real
   * room.
   */
  describe('demo caption room guards', (it) => {
    // A real, database-generated uid. Deliberately one hex digit away from
    // DEMO_ROOM_UID's tail so a sloppy prefix/substring match would trip on it.
    const ORDINARY_ROOM_UID = 'deadbeef-0000-4000-8000-000000000013';
    const ORDINARY_DEVICE_UID = '7f3c1b2a-9d84-4c11-9f5e-2a6b8c0d4e71';

    it("refuses to add a device to the demo room with 'DEMO_ROOM_NOT_ASSIGNABLE'", async () => {
      // Arrange - the room and device both exist as far as the repositories are
      // concerned, so a refusal here can only come from the demo-room guard.
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockDeviceRepo.findById.mockResolvedValue(mockDevice);

      // Act
      const result = await service.addDeviceToRoom({
        roomUid: DEMO_ROOM_UID,
        deviceUid: ORDINARY_DEVICE_UID,
        asSource: true,
      });

      // Assert
      expect(result).toBe('DEMO_ROOM_NOT_ASSIGNABLE');
      expect(mockRoomRepo.addDeviceToRoom).not.toHaveBeenCalled();
    });

    it('still adds a device to an ordinary room whose uid resembles the demo room uid', async () => {
      // Arrange - the guard must be an exact-uid match, not a prefix or family
      // match: ORDINARY_ROOM_UID shares the demo room's `deadbeef` prefix.
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockDeviceRepo.findById.mockResolvedValue(mockDevice);
      mockRoomRepo.addDeviceToRoom.mockResolvedValue(undefined);

      // Act
      const result = await service.addDeviceToRoom({
        roomUid: ORDINARY_ROOM_UID,
        deviceUid: ORDINARY_DEVICE_UID,
        asSource: true,
      });

      // Assert
      expect(result).toBeUndefined();
      expect(mockRoomRepo.addDeviceToRoom).toHaveBeenCalledWith(
        ORDINARY_ROOM_UID,
        ORDINARY_DEVICE_UID,
        true,
      );
    });

    it("refuses to add the demo placeholder source device to any room with 'DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE'", async () => {
      // Arrange - mirror image of the refusal above: the placeholder device is
      // never activated, so a real room whose source it became would look
      // configured and stay permanently silent.
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockDeviceRepo.findById.mockResolvedValue(mockDevice);

      // Act
      const result = await service.addDeviceToRoom({
        roomUid: ORDINARY_ROOM_UID,
        deviceUid: DEMO_SOURCE_DEVICE_UID,
        asSource: true,
      });

      // Assert
      expect(result).toBe('DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE');
      expect(mockRoomRepo.addDeviceToRoom).not.toHaveBeenCalled();
    });

    it("refuses to make any device the demo room's source with 'DEMO_ROOM_NOT_ASSIGNABLE'", async () => {
      // Arrange - the most misleading mutation of all: an operator would expect
      // audio from this device to be transcribed, and it never will be.
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockRoomRepo.setSourceDevice.mockResolvedValue(true);

      // Act
      const result = await service.setSourceDevice(
        DEMO_ROOM_UID,
        ORDINARY_DEVICE_UID,
      );

      // Assert
      expect(result).toBe('DEMO_ROOM_NOT_ASSIGNABLE');
      expect(mockRoomRepo.setSourceDevice).not.toHaveBeenCalled();
    });

    it('still promotes a source device in an ordinary room', async () => {
      // Arrange - the ordinary path through the same method, to prove the guard
      // did not swallow it.
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockRoomRepo.setSourceDevice.mockResolvedValue(true);

      // Act
      const result = await service.setSourceDevice(
        ORDINARY_ROOM_UID,
        ORDINARY_DEVICE_UID,
      );

      // Assert
      expect(result).toBeUndefined();
      expect(mockRoomRepo.setSourceDevice).toHaveBeenCalledWith(
        ORDINARY_ROOM_UID,
        ORDINARY_DEVICE_UID,
      );
    });

    it("refuses to promote the demo placeholder source device with 'DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE'", async () => {
      // Arrange - reachable for a room that acquired the placeholder device
      // before these guards existed; refusing keeps the state from getting
      // worse while `remove-device-from-room` stays available to clean it up.
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockRoomRepo.setSourceDevice.mockResolvedValue(true);

      // Act
      const result = await service.setSourceDevice(
        ORDINARY_ROOM_UID,
        DEMO_SOURCE_DEVICE_UID,
      );

      // Assert
      expect(result).toBe('DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE');
      expect(mockRoomRepo.setSourceDevice).not.toHaveBeenCalled();
    });

    it("refuses to create a room sourced by the demo placeholder device with 'DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE'", async () => {
      // Arrange - a created room can never *be* the demo room (its uid comes
      // from the database), so the placeholder device is the only demo-room
      // state create-room can reach. The device is unassigned here (as it would
      // be after the demo room was deleted), so nothing else would refuse it.
      mockDeviceRepo.findById.mockResolvedValue({
        ...mockDevice,
        uid: DEMO_SOURCE_DEVICE_UID,
        roomUid: null,
      });
      mockRoomRepo.create.mockResolvedValue(mockRoom);

      // Act
      const result = await service.createRoom({
        name: 'Room',
        timezone: VALID_TIMEZONE,
        sourceDeviceUids: [DEMO_SOURCE_DEVICE_UID],
        autoSessionEnabled: true,
      });

      // Assert
      expect(result).toBe('DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE');
      expect(mockRoomRepo.create).not.toHaveBeenCalled();
    });

    it('still creates an ordinary room with an ordinary source device', async () => {
      // Arrange - the create path with no demo uid anywhere in the request.
      mockDeviceRepo.findById.mockResolvedValue(mockDevice);
      mockRoomRepo.create.mockResolvedValue(mockRoom);
      mockRoomRepo.addDeviceToRoom.mockResolvedValue(undefined);

      // Act
      const result = await service.createRoom({
        name: 'Room',
        timezone: VALID_TIMEZONE,
        sourceDeviceUids: [ORDINARY_DEVICE_UID],
        autoSessionEnabled: true,
      });

      // Assert
      expect(result).toStrictEqual(mockRoom);
      expect(mockRoomRepo.create).toHaveBeenCalledTimes(1);
    });

    it('still removes a non-source device that is a member of the demo room', async () => {
      // Arrange - detaching only ever makes a room emptier, so it is left
      // unguarded on purpose: it is the escape hatch for a device attached to
      // the demo room before the guards existed.
      mockRoomRepo.findRoomMembership.mockResolvedValue({
        room_uid: DEMO_ROOM_UID,
        is_source: false,
      });
      mockRoomRepo.removeDeviceFromRoom.mockResolvedValue(true);

      // Act
      const result = await service.removeDeviceFromRoom(ORDINARY_DEVICE_UID);

      // Assert
      expect(result).toBeUndefined();
      expect(mockRoomRepo.removeDeviceFromRoom).toHaveBeenCalledWith(
        ORDINARY_DEVICE_UID,
      );
    });
  });

  /**
   * The seeded operator test-audio sources, guarded for a different and more
   * serious reason than the demo room's placeholder.
   *
   * These devices are real: activated, credentialled, and streaming synthetic
   * speech into whatever session is active in their room. A device token reaches
   * only its own device's room, so the room each is seeded into is the entire
   * thing keeping fixture speech out of a live lecture. `remove-device-from-room`
   * already refuses to detach them (each is its room's only source), but that
   * stops covering the moment someone deletes the test room — the documented way
   * to retire these devices — which leaves a roomless device with a still-valid
   * credential and nothing but this guard between it and a lecture hall.
   */
  describe('test-audio room guards', (it) => {
    const ORDINARY_ROOM_UID = 'b1f0c2d3-4e5a-4b6c-8d7e-9f0a1b2c3d4e';
    const ORDINARY_DEVICE_UID = '7f3c1b2a-9d84-4c11-9f5e-2a6b8c0d4e71';

    it("refuses to add a seeded synthetic source to another room with 'TEST_AUDIO_DEVICE_NOT_ASSIGNABLE'", async () => {
      // Arrange - the dangerous direction, and the whole reason this guard
      // exists: an ordinary room that could perfectly well take this device, and
      // synthetic speech that would be transcribed into its captions.
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockDeviceRepo.findById.mockResolvedValue({
        ...mockDevice,
        uid: TEST_AUDIO_GOOD_DEVICE_UID,
        roomUid: null,
      });

      // Act
      const result = await service.addDeviceToRoom({
        roomUid: ORDINARY_ROOM_UID,
        deviceUid: TEST_AUDIO_GOOD_DEVICE_UID,
        asSource: true,
      });

      // Assert
      expect(result).toBe('TEST_AUDIO_DEVICE_NOT_ASSIGNABLE');
      expect(mockRoomRepo.addDeviceToRoom).not.toHaveBeenCalled();
    });

    it("refuses to create a room sourced by a seeded synthetic source with 'TEST_AUDIO_DEVICE_NOT_ASSIGNABLE'", async () => {
      // Arrange - the same escape by a different route. The device is
      // unassigned, exactly as it would be after its test room was deleted, so
      // `DEVICE_ALREADY_IN_ROOM` would not catch it.
      mockDeviceRepo.findById.mockResolvedValue({
        ...mockDevice,
        uid: TEST_AUDIO_GOOD_DEVICE_UID,
        roomUid: null,
      });
      mockRoomRepo.create.mockResolvedValue(mockRoom);

      // Act
      const result = await service.createRoom({
        name: 'Lecture Hall 1',
        timezone: VALID_TIMEZONE,
        sourceDeviceUids: [TEST_AUDIO_GOOD_DEVICE_UID],
        autoSessionEnabled: true,
      });

      // Assert
      expect(result).toBe('TEST_AUDIO_DEVICE_NOT_ASSIGNABLE');
      expect(mockRoomRepo.create).not.toHaveBeenCalled();
    });

    it("refuses to promote a seeded synthetic source in another room with 'TEST_AUDIO_DEVICE_NOT_ASSIGNABLE'", async () => {
      // Arrange
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockRoomRepo.setSourceDevice.mockResolvedValue(true);

      // Act
      const result = await service.setSourceDevice(
        ORDINARY_ROOM_UID,
        TEST_AUDIO_GOOD_DEVICE_UID,
      );

      // Assert
      expect(result).toBe('TEST_AUDIO_DEVICE_NOT_ASSIGNABLE');
      expect(mockRoomRepo.setSourceDevice).not.toHaveBeenCalled();
    });

    it("refuses to add a device to a seeded test-audio room with 'TEST_AUDIO_ROOM_NOT_ASSIGNABLE'", async () => {
      // Arrange - the mirror image. Harmless on its own, but it is the first
      // half of demoting the synthetic source, which leaves a device that
      // authenticates, finds the session and is silently denied SEND_AUDIO.
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockDeviceRepo.findById.mockResolvedValue(mockDevice);

      // Act
      const result = await service.addDeviceToRoom({
        roomUid: TEST_AUDIO_GOOD_ROOM_UID,
        deviceUid: ORDINARY_DEVICE_UID,
        asSource: false,
      });

      // Assert
      expect(result).toBe('TEST_AUDIO_ROOM_NOT_ASSIGNABLE');
      expect(mockRoomRepo.addDeviceToRoom).not.toHaveBeenCalled();
    });

    it("refuses to hand a seeded test-audio room a different source with 'TEST_AUDIO_ROOM_NOT_ASSIGNABLE'", async () => {
      // Arrange - and the second half. It would also make the next boot's
      // re-seed trip the "at most one source per room" trigger, so a 409 naming
      // the room is a better answer than either outcome.
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockRoomRepo.setSourceDevice.mockResolvedValue(true);

      // Act
      const result = await service.setSourceDevice(
        TEST_AUDIO_GOOD_ROOM_UID,
        ORDINARY_DEVICE_UID,
      );

      // Assert
      expect(result).toBe('TEST_AUDIO_ROOM_NOT_ASSIGNABLE');
      expect(mockRoomRepo.setSourceDevice).not.toHaveBeenCalled();
    });

    it('still attaches an ordinary device to an ordinary room', async () => {
      // Arrange - the guard is an exact-uid match against two literals, and
      // every other room and device uid is generated by the database. This is
      // the case that would break if it ever became looser than that.
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockDeviceRepo.findById.mockResolvedValue(mockDevice);
      mockRoomRepo.addDeviceToRoom.mockResolvedValue(undefined);

      // Act
      const result = await service.addDeviceToRoom({
        roomUid: ORDINARY_ROOM_UID,
        deviceUid: ORDINARY_DEVICE_UID,
        asSource: true,
      });

      // Assert
      expect(result).toBeUndefined();
      expect(mockRoomRepo.addDeviceToRoom).toHaveBeenCalledWith(
        ORDINARY_ROOM_UID,
        ORDINARY_DEVICE_UID,
        true,
      );
    });
  });

  /**
   * The seeded monitoring canary source, guarded for the same reasons as the
   * test-audio sources above — with one difference that is why it is guarded at
   * all rather than left to `WOULD_LEAVE_ROOM_WITHOUT_SOURCE`.
   *
   * The canary is the fleet's only synthetic source that runs UNATTENDED. The
   * operator test devices stream while somebody watches a meter, so a mistake is
   * caught in seconds; the canary starts itself every probe interval, forever,
   * with nobody looking. And the gap is the same one: deleting the canary room
   * is the documented way to retire it, and that leaves a roomless device with a
   * still-valid derived credential one `add-device-to-room` from a lecture hall.
   */
  describe('monitoring canary room guards', (it) => {
    const ORDINARY_ROOM_UID = 'b1f0c2d3-4e5a-4b6c-8d7e-9f0a1b2c3d4e';
    const ORDINARY_DEVICE_UID = '7f3c1b2a-9d84-4c11-9f5e-2a6b8c0d4e71';

    it("refuses to add the canary source to another room with 'CANARY_DEVICE_NOT_ASSIGNABLE'", async () => {
      // Arrange - the dangerous direction: an ordinary room that could
      // perfectly well take this device, and a fixture recording that would be
      // transcribed into its captions on the next probe tick.
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockDeviceRepo.findById.mockResolvedValue({
        ...mockDevice,
        uid: CANARY_DEVICE_UID,
        roomUid: null,
      });

      // Act
      const result = await service.addDeviceToRoom({
        roomUid: ORDINARY_ROOM_UID,
        deviceUid: CANARY_DEVICE_UID,
        asSource: true,
      });

      // Assert
      expect(result).toBe('CANARY_DEVICE_NOT_ASSIGNABLE');
      expect(mockRoomRepo.addDeviceToRoom).not.toHaveBeenCalled();
    });

    it("refuses to create a room sourced by the canary device with 'CANARY_DEVICE_NOT_ASSIGNABLE'", async () => {
      // Arrange - the same escape by a different route. The device is
      // unassigned, exactly as it would be after the canary room was deleted,
      // so `DEVICE_ALREADY_IN_ROOM` would not catch it.
      mockDeviceRepo.findById.mockResolvedValue({
        ...mockDevice,
        uid: CANARY_DEVICE_UID,
        roomUid: null,
      });
      mockRoomRepo.create.mockResolvedValue(mockRoom);

      // Act
      const result = await service.createRoom({
        name: 'Lecture Hall 1',
        timezone: VALID_TIMEZONE,
        sourceDeviceUids: [CANARY_DEVICE_UID],
        autoSessionEnabled: true,
      });

      // Assert
      expect(result).toBe('CANARY_DEVICE_NOT_ASSIGNABLE');
      expect(mockRoomRepo.create).not.toHaveBeenCalled();
    });

    it("refuses to promote the canary source in another room with 'CANARY_DEVICE_NOT_ASSIGNABLE'", async () => {
      // Arrange
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockRoomRepo.setSourceDevice.mockResolvedValue(true);

      // Act
      const result = await service.setSourceDevice(
        ORDINARY_ROOM_UID,
        CANARY_DEVICE_UID,
      );

      // Assert
      expect(result).toBe('CANARY_DEVICE_NOT_ASSIGNABLE');
      expect(mockRoomRepo.setSourceDevice).not.toHaveBeenCalled();
    });

    it("refuses to add a device to the canary room with 'CANARY_ROOM_NOT_ASSIGNABLE'", async () => {
      // Arrange - the mirror image, and the first half of demoting the canary:
      // it would still authenticate and still find the session, but be silently
      // denied SEND_AUDIO, so every probe would report NO_TRANSCRIPTS and the
      // monitoring would be reporting a break that was its own.
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockDeviceRepo.findById.mockResolvedValue(mockDevice);

      // Act
      const result = await service.addDeviceToRoom({
        roomUid: CANARY_ROOM_UID,
        deviceUid: ORDINARY_DEVICE_UID,
        asSource: false,
      });

      // Assert
      expect(result).toBe('CANARY_ROOM_NOT_ASSIGNABLE');
      expect(mockRoomRepo.addDeviceToRoom).not.toHaveBeenCalled();
    });

    it("refuses to hand the canary room a different source with 'CANARY_ROOM_NOT_ASSIGNABLE'", async () => {
      // Arrange
      mockRoomRepo.findRoomExists.mockResolvedValue(true);
      mockRoomRepo.setSourceDevice.mockResolvedValue(true);

      // Act
      const result = await service.setSourceDevice(
        CANARY_ROOM_UID,
        ORDINARY_DEVICE_UID,
      );

      // Assert
      expect(result).toBe('CANARY_ROOM_NOT_ASSIGNABLE');
      expect(mockRoomRepo.setSourceDevice).not.toHaveBeenCalled();
    });

    it('refuses before any lookup, so the answer does not depend on the seeder having run', async () => {
      // Arrange - a deployment with CANARY_DEVICE_SECRET unset has no canary
      // room and no canary device. The uids stay reserved regardless, and a
      // request naming them must get the specific refusal rather than a 404
      // that invites the operator to try again once it is seeded.
      mockRoomRepo.findRoomExists.mockResolvedValue(false);
      mockDeviceRepo.findById.mockResolvedValue(undefined);

      // Act
      const result = await service.addDeviceToRoom({
        roomUid: CANARY_ROOM_UID,
        deviceUid: CANARY_DEVICE_UID,
        asSource: true,
      });

      // Assert
      expect(result).toBe('CANARY_ROOM_NOT_ASSIGNABLE');
      expect(mockRoomRepo.findRoomExists).not.toHaveBeenCalled();
      expect(mockDeviceRepo.findById).not.toHaveBeenCalled();
    });
  });
});
