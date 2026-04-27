import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { RoomManagementController } from '#src/server/features/room-management/room-management.controller.js';

const FAKE_DATE = new Date('2025-01-01T00:00:00.000Z');

const mockRoom = {
  uid: 'room-1',
  name: 'Test Room',
  timezone: 'America/New_York',
  roomScheduleVersion: 1,
  createdAt: FAKE_DATE,
};

describe('RoomManagementController', () => {
  let mockService: {
    listRooms: Mock;
    getRoom: Mock;
    createRoom: Mock;
    updateRoom: Mock;
    deleteRoom: Mock;
    addDeviceToRoom: Mock;
    removeDeviceFromRoom: Mock;
    setSourceDevice: Mock;
    getMyRoom: Mock;
  };
  let controller: RoomManagementController;
  let mockSend: Mock;
  let mockCode: Mock;
  let mockRes: { code: Mock };

  beforeEach(() => {
    mockService = {
      listRooms: vi.fn(),
      getRoom: vi.fn(),
      createRoom: vi.fn(),
      updateRoom: vi.fn(),
      deleteRoom: vi.fn(),
      addDeviceToRoom: vi.fn(),
      removeDeviceFromRoom: vi.fn(),
      setSourceDevice: vi.fn(),
      getMyRoom: vi.fn(),
    };

    controller = new RoomManagementController(mockService as never);

    mockSend = vi.fn();
    mockCode = vi.fn().mockReturnValue({ send: mockSend });
    mockRes = { code: mockCode };
  });

  describe('listRooms', (it) => {
    it('forwards all query params to the service', async () => {
      // Arrange
      mockService.listRooms.mockResolvedValue({ items: [], nextCursor: null });
      const mockReq = {
        query: { search: 'conf', cursor: 'abc', limit: 20 },
      };

      // Act
      await controller.listRooms(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.listRooms).toHaveBeenCalledWith({
        search: 'conf',
        cursor: 'abc',
        limit: 20,
      });
    });

    it('serializes createdAt to ISO string for each item', async () => {
      // Arrange
      mockService.listRooms.mockResolvedValue({
        items: [mockRoom],
        nextCursor: null,
      });
      const mockReq = { query: { search: undefined, cursor: undefined } };

      // Act
      await controller.listRooms(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith({
        items: [{ ...mockRoom, createdAt: FAKE_DATE.toISOString() }],
        nextCursor: null,
      });
    });

    it('uses default limit of 50 when not provided', async () => {
      // Arrange
      mockService.listRooms.mockResolvedValue({ items: [], nextCursor: null });
      const mockReq = { query: { search: undefined, cursor: undefined } };

      // Act
      await controller.listRooms(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.listRooms).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 50 }),
      );
    });
  });

  describe('getRoom', (it) => {
    it('calls the service with the roomUid from params', async () => {
      // Arrange
      mockService.getRoom.mockResolvedValue(mockRoom);
      const mockReq = { params: { roomUid: 'room-1' } };

      // Act
      await controller.getRoom(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.getRoom).toHaveBeenCalledWith('room-1');
    });

    it("throws 404 when service returns 'ROOM_NOT_FOUND'", async () => {
      // Arrange
      mockService.getRoom.mockResolvedValue('ROOM_NOT_FOUND');
      const mockReq = { params: { roomUid: 'room-1' } };

      // Act + Assert
      await expect(
        controller.getRoom(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 404, code: 'ROOM_NOT_FOUND' });
    });

    it('serializes createdAt to ISO string', async () => {
      // Arrange
      mockService.getRoom.mockResolvedValue(mockRoom);
      const mockReq = { params: { roomUid: 'room-1' } };

      // Act
      await controller.getRoom(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ createdAt: FAKE_DATE.toISOString() }),
      );
    });
  });

  describe('createRoom', (it) => {
    it('calls the service with the full request body', async () => {
      // Arrange
      mockService.createRoom.mockResolvedValue(mockRoom);
      const body = {
        name: 'Test Room',
        timezone: 'America/New_York',
        sourceDeviceUids: ['d-1'],
      };
      const mockReq = { body };

      // Act
      await controller.createRoom(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.createRoom).toHaveBeenCalledWith(body);
    });

    it("throws 422 when service returns 'INVALID_TIMEZONE'", async () => {
      // Arrange
      mockService.createRoom.mockResolvedValue('INVALID_TIMEZONE');
      const mockReq = {
        body: { name: 'Room', timezone: 'Bad/Zone', sourceDeviceUids: ['d-1'] },
      };

      // Act + Assert
      await expect(
        controller.createRoom(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 422, code: 'INVALID_TIMEZONE' });
    });

    it("throws 409 when service returns 'TOO_MANY_SOURCE_DEVICES'", async () => {
      // Arrange
      mockService.createRoom.mockResolvedValue('TOO_MANY_SOURCE_DEVICES');
      const mockReq = {
        body: {
          name: 'Room',
          timezone: 'America/New_York',
          sourceDeviceUids: ['d-1', 'd-2'],
        },
      };

      // Act + Assert
      await expect(
        controller.createRoom(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'TOO_MANY_SOURCE_DEVICES',
      });
    });

    it("throws 422 when service returns 'NO_SOURCE_DEVICE'", async () => {
      // Arrange
      mockService.createRoom.mockResolvedValue('NO_SOURCE_DEVICE');
      const mockReq = {
        body: {
          name: 'Room',
          timezone: 'America/New_York',
          sourceDeviceUids: [],
        },
      };

      // Act + Assert
      await expect(
        controller.createRoom(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 422, code: 'NO_SOURCE_DEVICE' });
    });

    it("throws 404 when service returns 'DEVICE_NOT_FOUND'", async () => {
      // Arrange
      mockService.createRoom.mockResolvedValue('DEVICE_NOT_FOUND');
      const mockReq = {
        body: {
          name: 'Room',
          timezone: 'America/New_York',
          sourceDeviceUids: ['d-1'],
        },
      };

      // Act + Assert
      await expect(
        controller.createRoom(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 404, code: 'DEVICE_NOT_FOUND' });
    });

    it("throws 409 when service returns 'DEVICE_ALREADY_IN_ROOM'", async () => {
      // Arrange
      mockService.createRoom.mockResolvedValue('DEVICE_ALREADY_IN_ROOM');
      const mockReq = {
        body: {
          name: 'Room',
          timezone: 'America/New_York',
          sourceDeviceUids: ['d-1'],
        },
      };

      // Act + Assert
      await expect(
        controller.createRoom(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'DEVICE_ALREADY_IN_ROOM',
      });
    });

    it('serializes createdAt to ISO string on success', async () => {
      // Arrange
      mockService.createRoom.mockResolvedValue(mockRoom);
      const mockReq = {
        body: {
          name: 'Test Room',
          timezone: 'America/New_York',
          sourceDeviceUids: ['d-1'],
        },
      };

      // Act
      await controller.createRoom(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(201);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ createdAt: FAKE_DATE.toISOString() }),
      );
    });
  });

  describe('updateRoom', (it) => {
    it("throws 404 when service returns 'ROOM_NOT_FOUND'", async () => {
      // Arrange
      mockService.updateRoom.mockResolvedValue('ROOM_NOT_FOUND');
      const mockReq = { body: { roomUid: 'room-1', name: 'New Name' } };

      // Act + Assert
      await expect(
        controller.updateRoom(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 404, code: 'ROOM_NOT_FOUND' });
    });

    it('serializes createdAt to ISO string on success', async () => {
      // Arrange
      mockService.updateRoom.mockResolvedValue({
        ...mockRoom,
        name: 'New Name',
      });
      const mockReq = { body: { roomUid: 'room-1', name: 'New Name' } };

      // Act
      await controller.updateRoom(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ createdAt: FAKE_DATE.toISOString() }),
      );
    });

    it('strips roomUid from the update payload sent to the service', async () => {
      // Arrange
      mockService.updateRoom.mockResolvedValue(mockRoom);
      const mockReq = { body: { roomUid: 'room-1', name: 'New Name' } };

      // Act
      await controller.updateRoom(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.updateRoom).toHaveBeenCalledWith('room-1', {
        name: 'New Name',
      });
    });
  });

  describe('deleteRoom', (it) => {
    it('calls the service with the roomUid from the body', async () => {
      // Arrange
      mockService.deleteRoom.mockResolvedValue(undefined);
      const mockReq = { body: { roomUid: 'room-1' } };

      // Act
      await controller.deleteRoom(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.deleteRoom).toHaveBeenCalledWith('room-1');
    });

    it("throws 404 when service returns 'ROOM_NOT_FOUND'", async () => {
      // Arrange
      mockService.deleteRoom.mockResolvedValue('ROOM_NOT_FOUND');
      const mockReq = { body: { roomUid: 'room-1' } };

      // Act + Assert
      await expect(
        controller.deleteRoom(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 404, code: 'ROOM_NOT_FOUND' });
    });

    it('sends 204 with null on success', async () => {
      // Arrange
      mockService.deleteRoom.mockResolvedValue(undefined);
      const mockReq = { body: { roomUid: 'room-1' } };

      // Act
      await controller.deleteRoom(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(204);
      expect(mockSend).toHaveBeenCalledWith(null);
    });
  });

  describe('addDeviceToRoom', (it) => {
    it("throws 404 when service returns 'ROOM_NOT_FOUND'", async () => {
      // Arrange
      mockService.addDeviceToRoom.mockResolvedValue('ROOM_NOT_FOUND');
      const mockReq = {
        body: { roomUid: 'room-1', deviceUid: 'device-1', asSource: false },
      };

      // Act + Assert
      await expect(
        controller.addDeviceToRoom(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 404, code: 'ROOM_NOT_FOUND' });
    });

    it("throws 404 when service returns 'DEVICE_NOT_FOUND'", async () => {
      // Arrange
      mockService.addDeviceToRoom.mockResolvedValue('DEVICE_NOT_FOUND');
      const mockReq = {
        body: { roomUid: 'room-1', deviceUid: 'device-1', asSource: false },
      };

      // Act + Assert
      await expect(
        controller.addDeviceToRoom(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 404, code: 'DEVICE_NOT_FOUND' });
    });

    it("throws 409 when service returns 'DEVICE_ALREADY_IN_ROOM'", async () => {
      // Arrange
      mockService.addDeviceToRoom.mockResolvedValue('DEVICE_ALREADY_IN_ROOM');
      const mockReq = {
        body: { roomUid: 'room-1', deviceUid: 'device-1', asSource: false },
      };

      // Act + Assert
      await expect(
        controller.addDeviceToRoom(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'DEVICE_ALREADY_IN_ROOM',
      });
    });

    it('calls the service with roomUid, deviceUid, and asSource from the body', async () => {
      // Arrange
      mockService.addDeviceToRoom.mockResolvedValue(undefined);
      const mockReq = {
        body: { roomUid: 'room-1', deviceUid: 'device-1', asSource: true },
      };

      // Act
      await controller.addDeviceToRoom(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.addDeviceToRoom).toHaveBeenCalledWith({
        roomUid: 'room-1',
        deviceUid: 'device-1',
        asSource: true,
      });
    });

    it('sends 204 with null on success', async () => {
      // Arrange
      mockService.addDeviceToRoom.mockResolvedValue(undefined);
      const mockReq = {
        body: { roomUid: 'room-1', deviceUid: 'device-1', asSource: false },
      };

      // Act
      await controller.addDeviceToRoom(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(204);
      expect(mockSend).toHaveBeenCalledWith(null);
    });
  });

  describe('removeDeviceFromRoom', (it) => {
    it('calls the service with the deviceUid from the body', async () => {
      // Arrange
      mockService.removeDeviceFromRoom.mockResolvedValue(undefined);
      const mockReq = { body: { deviceUid: 'device-1' } };

      // Act
      await controller.removeDeviceFromRoom(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.removeDeviceFromRoom).toHaveBeenCalledWith('device-1');
    });

    it("throws 404 when service returns 'MEMBERSHIP_NOT_FOUND'", async () => {
      // Arrange
      mockService.removeDeviceFromRoom.mockResolvedValue(
        'MEMBERSHIP_NOT_FOUND',
      );
      const mockReq = { body: { deviceUid: 'device-1' } };

      // Act + Assert
      await expect(
        controller.removeDeviceFromRoom(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 404,
        code: 'MEMBERSHIP_NOT_FOUND',
      });
    });

    it("throws 409 when service returns 'WOULD_LEAVE_ROOM_WITHOUT_SOURCE'", async () => {
      // Arrange
      mockService.removeDeviceFromRoom.mockResolvedValue(
        'WOULD_LEAVE_ROOM_WITHOUT_SOURCE',
      );
      const mockReq = { body: { deviceUid: 'device-1' } };

      // Act + Assert
      await expect(
        controller.removeDeviceFromRoom(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'WOULD_LEAVE_ROOM_WITHOUT_SOURCE',
      });
    });

    it('sends 204 with null on success', async () => {
      // Arrange
      mockService.removeDeviceFromRoom.mockResolvedValue(undefined);
      const mockReq = { body: { deviceUid: 'device-1' } };

      // Act
      await controller.removeDeviceFromRoom(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(204);
      expect(mockSend).toHaveBeenCalledWith(null);
    });
  });

  describe('setSourceDevice', (it) => {
    it('calls the service with roomUid and deviceUid from the body', async () => {
      // Arrange
      mockService.setSourceDevice.mockResolvedValue(undefined);
      const mockReq = { body: { roomUid: 'room-1', deviceUid: 'device-1' } };

      // Act
      await controller.setSourceDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.setSourceDevice).toHaveBeenCalledWith(
        'room-1',
        'device-1',
      );
    });

    it("throws 404 when service returns 'ROOM_NOT_FOUND'", async () => {
      // Arrange
      mockService.setSourceDevice.mockResolvedValue('ROOM_NOT_FOUND');
      const mockReq = { body: { roomUid: 'room-1', deviceUid: 'device-1' } };

      // Act + Assert
      await expect(
        controller.setSourceDevice(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 404, code: 'ROOM_NOT_FOUND' });
    });

    it("throws 404 when service returns 'DEVICE_NOT_IN_ROOM'", async () => {
      // Arrange
      mockService.setSourceDevice.mockResolvedValue('DEVICE_NOT_IN_ROOM');
      const mockReq = { body: { roomUid: 'room-1', deviceUid: 'device-1' } };

      // Act + Assert
      await expect(
        controller.setSourceDevice(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 404, code: 'DEVICE_NOT_IN_ROOM' });
    });

    it('sends 204 with null on success', async () => {
      // Arrange
      mockService.setSourceDevice.mockResolvedValue(undefined);
      const mockReq = { body: { roomUid: 'room-1', deviceUid: 'device-1' } };

      // Act
      await controller.setSourceDevice(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(204);
      expect(mockSend).toHaveBeenCalledWith(null);
    });
  });

  describe('getMyRoom', (it) => {
    it('calls the service with the deviceUid from the request', async () => {
      // Arrange
      mockService.getMyRoom.mockResolvedValue({
        uid: 'room-1',
        name: 'Test Room',
        timezone: 'America/New_York',
        roomScheduleVersion: 1,
      });
      const mockReq = { deviceUid: 'device-1' };

      // Act
      await controller.getMyRoom(mockReq as never, mockRes as never);

      // Assert
      expect(mockService.getMyRoom).toHaveBeenCalledWith('device-1');
    });

    it("throws 404 when service returns 'DEVICE_NOT_IN_ROOM'", async () => {
      // Arrange
      mockService.getMyRoom.mockResolvedValue('DEVICE_NOT_IN_ROOM');
      const mockReq = { deviceUid: 'device-1' };

      // Act + Assert
      await expect(
        controller.getMyRoom(mockReq as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 404, code: 'DEVICE_NOT_IN_ROOM' });
    });

    it('passes the service result through unchanged', async () => {
      // Arrange
      const myRoom = {
        uid: 'room-1',
        name: 'Test Room',
        timezone: 'America/New_York',
        roomScheduleVersion: 1,
      };
      mockService.getMyRoom.mockResolvedValue(myRoom);
      const mockReq = { deviceUid: 'device-1' };

      // Act
      await controller.getMyRoom(mockReq as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith({
        uid: mockRoom.uid,
        name: mockRoom.name,
        timezone: mockRoom.timezone,
        roomScheduleVersion: mockRoom.roomScheduleVersion,
      });
      expect(mockSend).not.toHaveBeenCalledWith(
        expect.objectContaining({ createdAt: expect.anything() }),
      );
    });
  });
});
