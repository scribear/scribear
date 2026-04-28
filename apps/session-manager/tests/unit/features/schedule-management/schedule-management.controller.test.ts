import { EventEmitter } from 'node:events';
import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import { ScheduleManagementController } from '#src/server/features/schedule-management/schedule-management.controller.js';
import {
  RoomScheduleVersionBumpedChannel,
  SessionConfigVersionBumpedChannel,
} from '#src/server/shared/events/schedule-management.events.js';
import { EventBusService } from '#src/server/shared/services/event-bus.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

const FAKE_DATE = new Date('2025-01-01T00:00:00.000Z');
const FAKE_DATE_LATER = new Date('2025-01-01T01:00:00.000Z');

const mockSchedule = {
  uid: 'sched-1',
  roomUid: 'room-1',
  name: 'Standup',
  activeStart: FAKE_DATE,
  activeEnd: null,
  anchorStart: FAKE_DATE,
  localStartTime: '09:00:00',
  localEndTime: '10:00:00',
  frequency: 'WEEKLY',
  daysOfWeek: ['MON'],
  joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
  transcriptionProviderId: 'whisper',
  transcriptionStreamConfig: {},
  createdAt: FAKE_DATE,
};

const mockWindow = {
  uid: 'win-1',
  roomUid: 'room-1',
  localStartTime: '09:00:00',
  localEndTime: '17:00:00',
  daysOfWeek: ['MON', 'TUE'],
  joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
  transcriptionProviderId: 'whisper',
  transcriptionStreamConfig: {},
  activeStart: FAKE_DATE,
  activeEnd: null,
  createdAt: FAKE_DATE,
};

const mockSession = {
  uid: 'sess-1',
  roomUid: 'room-1',
  name: 'Session',
  type: 'SCHEDULED',
  scheduledSessionUid: 'sched-1',
  scheduledStartTime: FAKE_DATE,
  scheduledEndTime: FAKE_DATE_LATER,
  startOverride: null,
  endOverride: null,
  joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
  transcriptionProviderId: 'whisper',
  transcriptionStreamConfig: {},
  sessionConfigVersion: 1,
  createdAt: FAKE_DATE,
  effectiveStart: FAKE_DATE,
  effectiveEnd: FAKE_DATE_LATER,
};

describe('ScheduleManagementController', () => {
  let mockScheduleService: {
    listSchedulesForRoom: Mock;
    createSchedule: Mock;
    findScheduleByUid: Mock;
    updateSchedule: Mock;
    deleteSchedule: Mock;
    listAutoSessionWindowsForRoom: Mock;
    createAutoSessionWindow: Mock;
    findAutoSessionWindowByUid: Mock;
    updateAutoSessionWindow: Mock;
    deleteAutoSessionWindow: Mock;
    updateRoomScheduleConfig: Mock;
    getSession: Mock;
    createOnDemandSession: Mock;
    startSessionEarly: Mock;
    endSessionEarly: Mock;
    listActiveAndUpcomingSessions: Mock;
  };
  let mockRoomService: { getRoom: Mock; getMyRoom: Mock };
  let eventBus: EventBusService;
  let controller: ScheduleManagementController;
  let mockSend: Mock;
  let mockCode: Mock;
  let mockRes: { code: Mock };

  beforeEach(() => {
    mockScheduleService = {
      listSchedulesForRoom: vi.fn(),
      createSchedule: vi.fn(),
      findScheduleByUid: vi.fn(),
      updateSchedule: vi.fn(),
      deleteSchedule: vi.fn(),
      listAutoSessionWindowsForRoom: vi.fn(),
      createAutoSessionWindow: vi.fn(),
      findAutoSessionWindowByUid: vi.fn(),
      updateAutoSessionWindow: vi.fn(),
      deleteAutoSessionWindow: vi.fn(),
      updateRoomScheduleConfig: vi.fn(),
      getSession: vi.fn(),
      createOnDemandSession: vi.fn(),
      startSessionEarly: vi.fn(),
      endSessionEarly: vi.fn(),
      listActiveAndUpcomingSessions: vi.fn(),
    };
    mockRoomService = { getRoom: vi.fn(), getMyRoom: vi.fn() };
    eventBus = new EventBusService(createMockLogger() as never);

    controller = new ScheduleManagementController(
      mockScheduleService as never,
      mockRoomService as never,
      eventBus,
    );

    mockSend = vi.fn();
    mockCode = vi.fn().mockReturnValue({ send: mockSend });
    mockRes = { code: mockCode };
  });

  describe('createSchedule', (it) => {
    function makeBody() {
      return {
        roomUid: 'room-1',
        name: 'Standup',
        activeStart: FAKE_DATE.toISOString(),
        activeEnd: null,
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'WEEKLY',
        daysOfWeek: ['MON'],
        joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      };
    }

    it('passes parsed Date instances and Json-cast config to the service', async () => {
      // Arrange
      mockScheduleService.createSchedule.mockResolvedValue(mockSchedule);

      // Act
      await controller.createSchedule(
        { body: makeBody() } as never,
        mockRes as never,
      );

      // Assert
      expect(mockScheduleService.createSchedule).toHaveBeenCalledWith(
        expect.objectContaining({
          roomUid: 'room-1',
          activeStart: FAKE_DATE,
          activeEnd: null,
        }),
        expect.any(Date),
      );
    });

    it("throws 404 when service returns 'ROOM_NOT_FOUND'", async () => {
      // Arrange
      mockScheduleService.createSchedule.mockResolvedValue('ROOM_NOT_FOUND');

      // Act + Assert
      await expect(
        controller.createSchedule(
          { body: makeBody() } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'ROOM_NOT_FOUND' });
    });

    it("throws 409 when service returns 'CONFLICT'", async () => {
      // Arrange
      mockScheduleService.createSchedule.mockResolvedValue('CONFLICT');

      // Act + Assert
      await expect(
        controller.createSchedule(
          { body: makeBody() } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    });

    it('serializes activeStart, activeEnd, and createdAt on success', async () => {
      // Arrange
      mockScheduleService.createSchedule.mockResolvedValue({
        ...mockSchedule,
        activeEnd: FAKE_DATE_LATER,
      });

      // Act
      await controller.createSchedule(
        { body: makeBody() } as never,
        mockRes as never,
      );

      // Assert
      expect(mockCode).toHaveBeenCalledWith(201);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          activeStart: FAKE_DATE.toISOString(),
          activeEnd: FAKE_DATE_LATER.toISOString(),
          createdAt: FAKE_DATE.toISOString(),
        }),
      );
    });
  });

  describe('getSchedule', (it) => {
    it('returns 200 with serialized dates when found', async () => {
      // Arrange
      mockScheduleService.findScheduleByUid.mockResolvedValue(mockSchedule);

      // Act
      await controller.getSchedule(
        { params: { scheduleUid: 'sched-1' } } as never,
        mockRes as never,
      );

      // Assert
      expect(mockScheduleService.findScheduleByUid).toHaveBeenCalledWith(
        'sched-1',
      );
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          activeStart: FAKE_DATE.toISOString(),
          activeEnd: null,
          createdAt: FAKE_DATE.toISOString(),
        }),
      );
    });

    it("throws 404 when service returns 'NOT_FOUND'", async () => {
      // Arrange
      mockScheduleService.findScheduleByUid.mockResolvedValue('NOT_FOUND');

      // Act + Assert
      await expect(
        controller.getSchedule(
          { params: { scheduleUid: 'sched-1' } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'SCHEDULE_NOT_FOUND' });
    });
  });

  describe('updateSchedule', (it) => {
    it('only forwards fields that were provided on the request body', async () => {
      // Arrange
      mockScheduleService.updateSchedule.mockResolvedValue(mockSchedule);

      // Act
      await controller.updateSchedule(
        { body: { scheduleUid: 'sched-1', name: 'New Name' } } as never,
        mockRes as never,
      );

      // Assert
      expect(mockScheduleService.updateSchedule).toHaveBeenCalledWith(
        'sched-1',
        { name: 'New Name' },
        expect.any(Date),
      );
    });

    it('passes activeEnd: null through (clearing the field)', async () => {
      // Arrange
      mockScheduleService.updateSchedule.mockResolvedValue(mockSchedule);

      // Act
      await controller.updateSchedule(
        { body: { scheduleUid: 'sched-1', activeEnd: null } } as never,
        mockRes as never,
      );

      // Assert
      expect(mockScheduleService.updateSchedule).toHaveBeenCalledWith(
        'sched-1',
        { activeEnd: null },
        expect.any(Date),
      );
    });

    it("throws 404 when service returns 'NOT_FOUND'", async () => {
      // Arrange
      mockScheduleService.updateSchedule.mockResolvedValue('NOT_FOUND');

      // Act + Assert
      await expect(
        controller.updateSchedule(
          { body: { scheduleUid: 'sched-1' } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'SCHEDULE_NOT_FOUND' });
    });

    it("throws 409 when service returns 'CONFLICT'", async () => {
      // Arrange
      mockScheduleService.updateSchedule.mockResolvedValue('CONFLICT');

      // Act + Assert
      await expect(
        controller.updateSchedule(
          { body: { scheduleUid: 'sched-1' } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    });
  });

  describe('deleteSchedule', (it) => {
    it('returns 204 with null on success', async () => {
      // Arrange
      mockScheduleService.deleteSchedule.mockResolvedValue(undefined);

      // Act
      await controller.deleteSchedule(
        { body: { scheduleUid: 'sched-1' } } as never,
        mockRes as never,
      );

      // Assert
      expect(mockScheduleService.deleteSchedule).toHaveBeenCalledWith(
        'sched-1',
        expect.any(Date),
      );
      expect(mockCode).toHaveBeenCalledWith(204);
      expect(mockSend).toHaveBeenCalledWith(null);
    });

    it("throws 404 when service returns 'NOT_FOUND'", async () => {
      // Arrange
      mockScheduleService.deleteSchedule.mockResolvedValue('NOT_FOUND');

      // Act + Assert
      await expect(
        controller.deleteSchedule(
          { body: { scheduleUid: 'sched-1' } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'SCHEDULE_NOT_FOUND' });
    });
  });

  describe('createAutoSessionWindow', (it) => {
    function makeBody() {
      return {
        roomUid: 'room-1',
        localStartTime: '09:00:00',
        localEndTime: '17:00:00',
        daysOfWeek: ['MON', 'TUE'],
        activeStart: FAKE_DATE.toISOString(),
        activeEnd: null,
        joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      };
    }

    it('returns 201 with serialized dates on success', async () => {
      // Arrange
      mockScheduleService.createAutoSessionWindow.mockResolvedValue(mockWindow);

      // Act
      await controller.createAutoSessionWindow(
        { body: makeBody() } as never,
        mockRes as never,
      );

      // Assert
      expect(mockCode).toHaveBeenCalledWith(201);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          activeStart: FAKE_DATE.toISOString(),
          activeEnd: null,
          createdAt: FAKE_DATE.toISOString(),
        }),
      );
    });

    it("throws 404 when service returns 'ROOM_NOT_FOUND'", async () => {
      // Arrange
      mockScheduleService.createAutoSessionWindow.mockResolvedValue(
        'ROOM_NOT_FOUND',
      );

      // Act + Assert
      await expect(
        controller.createAutoSessionWindow(
          { body: makeBody() } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'ROOM_NOT_FOUND' });
    });

    it("throws 409 when service returns 'CONFLICT'", async () => {
      // Arrange
      mockScheduleService.createAutoSessionWindow.mockResolvedValue('CONFLICT');

      // Act + Assert
      await expect(
        controller.createAutoSessionWindow(
          { body: makeBody() } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    });
  });

  describe('getAutoSessionWindow', (it) => {
    it('returns 200 with serialized dates when found', async () => {
      // Arrange
      mockScheduleService.findAutoSessionWindowByUid.mockResolvedValue(
        mockWindow,
      );

      // Act
      await controller.getAutoSessionWindow(
        { params: { windowUid: 'win-1' } } as never,
        mockRes as never,
      );

      // Assert
      expect(
        mockScheduleService.findAutoSessionWindowByUid,
      ).toHaveBeenCalledWith('win-1');
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ uid: 'win-1' }),
      );
    });

    it("throws 404 when service returns 'NOT_FOUND'", async () => {
      // Arrange
      mockScheduleService.findAutoSessionWindowByUid.mockResolvedValue(
        'NOT_FOUND',
      );

      // Act + Assert
      await expect(
        controller.getAutoSessionWindow(
          { params: { windowUid: 'win-1' } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'WINDOW_NOT_FOUND' });
    });
  });

  describe('updateAutoSessionWindow', (it) => {
    it('only forwards fields that were provided on the request body', async () => {
      // Arrange
      mockScheduleService.updateAutoSessionWindow.mockResolvedValue(mockWindow);

      // Act
      await controller.updateAutoSessionWindow(
        { body: { windowUid: 'win-1', localStartTime: '08:00:00' } } as never,
        mockRes as never,
      );

      // Assert
      expect(mockScheduleService.updateAutoSessionWindow).toHaveBeenCalledWith(
        'win-1',
        { localStartTime: '08:00:00' },
        expect.any(Date),
      );
    });

    it("throws 404 when service returns 'NOT_FOUND'", async () => {
      // Arrange
      mockScheduleService.updateAutoSessionWindow.mockResolvedValue(
        'NOT_FOUND',
      );

      // Act + Assert
      await expect(
        controller.updateAutoSessionWindow(
          { body: { windowUid: 'win-1' } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'WINDOW_NOT_FOUND' });
    });

    it("throws 409 when service returns 'CONFLICT'", async () => {
      // Arrange
      mockScheduleService.updateAutoSessionWindow.mockResolvedValue('CONFLICT');

      // Act + Assert
      await expect(
        controller.updateAutoSessionWindow(
          { body: { windowUid: 'win-1' } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
    });
  });

  describe('deleteAutoSessionWindow', (it) => {
    it('returns 204 with null on success', async () => {
      // Arrange
      mockScheduleService.deleteAutoSessionWindow.mockResolvedValue(undefined);

      // Act
      await controller.deleteAutoSessionWindow(
        { body: { windowUid: 'win-1' } } as never,
        mockRes as never,
      );

      // Assert
      expect(mockScheduleService.deleteAutoSessionWindow).toHaveBeenCalledWith(
        'win-1',
        expect.any(Date),
      );
      expect(mockCode).toHaveBeenCalledWith(204);
      expect(mockSend).toHaveBeenCalledWith(null);
    });

    it("throws 404 when service returns 'NOT_FOUND'", async () => {
      // Arrange
      mockScheduleService.deleteAutoSessionWindow.mockResolvedValue(
        'NOT_FOUND',
      );

      // Act + Assert
      await expect(
        controller.deleteAutoSessionWindow(
          { body: { windowUid: 'win-1' } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'WINDOW_NOT_FOUND' });
    });
  });

  describe('updateRoomScheduleConfig', (it) => {
    it("throws 404 when service returns 'ROOM_NOT_FOUND'", async () => {
      // Arrange
      mockScheduleService.updateRoomScheduleConfig.mockResolvedValue(
        'ROOM_NOT_FOUND',
      );

      // Act + Assert
      await expect(
        controller.updateRoomScheduleConfig(
          { body: { roomUid: 'room-1', autoSessionEnabled: true } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'ROOM_NOT_FOUND' });
    });

    it('returns 200 with the room (createdAt serialized) on success', async () => {
      // Arrange
      mockScheduleService.updateRoomScheduleConfig.mockResolvedValue(undefined);
      const room = {
        uid: 'room-1',
        name: 'Test Room',
        timezone: 'UTC',
        autoSessionEnabled: true,
        roomScheduleVersion: 1,
        createdAt: FAKE_DATE,
      };
      mockRoomService.getRoom.mockResolvedValue(room);

      // Act
      await controller.updateRoomScheduleConfig(
        { body: { roomUid: 'room-1', autoSessionEnabled: true } } as never,
        mockRes as never,
      );

      // Assert
      expect(mockScheduleService.updateRoomScheduleConfig).toHaveBeenCalledWith(
        'room-1',
        { autoSessionEnabled: true },
        expect.any(Date),
      );
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith({
        ...room,
        createdAt: FAKE_DATE.toISOString(),
      });
    });

    it('throws 500 when room is missing after a successful service call', async () => {
      // Arrange
      mockScheduleService.updateRoomScheduleConfig.mockResolvedValue(undefined);
      mockRoomService.getRoom.mockResolvedValue('ROOM_NOT_FOUND');

      // Act + Assert
      await expect(
        controller.updateRoomScheduleConfig(
          { body: { roomUid: 'room-1', autoSessionEnabled: true } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 500 });
    });
  });

  describe('getSession', (it) => {
    it('returns 200 with serialized dates when found', async () => {
      // Arrange
      mockScheduleService.getSession.mockResolvedValue(mockSession);

      // Act
      await controller.getSession(
        { params: { sessionUid: 'sess-1' } } as never,
        mockRes as never,
      );

      // Assert
      expect(mockScheduleService.getSession).toHaveBeenCalledWith('sess-1');
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduledStartTime: FAKE_DATE.toISOString(),
          scheduledEndTime: FAKE_DATE_LATER.toISOString(),
          startOverride: null,
          endOverride: null,
          effectiveStart: FAKE_DATE.toISOString(),
          effectiveEnd: FAKE_DATE_LATER.toISOString(),
          createdAt: FAKE_DATE.toISOString(),
        }),
      );
    });

    it("throws 404 when service returns 'NOT_FOUND'", async () => {
      // Arrange
      mockScheduleService.getSession.mockResolvedValue('NOT_FOUND');

      // Act + Assert
      await expect(
        controller.getSession(
          { params: { sessionUid: 'sess-1' } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'SESSION_NOT_FOUND' });
    });
  });

  describe('createOnDemandSession', (it) => {
    function makeBody() {
      return {
        roomUid: 'room-1',
        name: 'Quick Meeting',
        joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      };
    }

    it('returns 201 with serialized dates on success', async () => {
      // Arrange
      mockScheduleService.createOnDemandSession.mockResolvedValue(mockSession);

      // Act
      await controller.createOnDemandSession(
        { body: makeBody() } as never,
        mockRes as never,
      );

      // Assert
      expect(mockCode).toHaveBeenCalledWith(201);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          scheduledStartTime: FAKE_DATE.toISOString(),
        }),
      );
    });

    it("throws 404 when service returns 'ROOM_NOT_FOUND'", async () => {
      // Arrange
      mockScheduleService.createOnDemandSession.mockResolvedValue(
        'ROOM_NOT_FOUND',
      );

      // Act + Assert
      await expect(
        controller.createOnDemandSession(
          { body: makeBody() } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'ROOM_NOT_FOUND' });
    });

    it("throws 409 when service returns 'ANOTHER_SESSION_ACTIVE'", async () => {
      // Arrange
      mockScheduleService.createOnDemandSession.mockResolvedValue(
        'ANOTHER_SESSION_ACTIVE',
      );

      // Act + Assert
      await expect(
        controller.createOnDemandSession(
          { body: makeBody() } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'ANOTHER_SESSION_ACTIVE',
      });
    });
  });

  describe('startSessionEarly', (it) => {
    it("throws 404 when service returns 'NOT_FOUND'", async () => {
      // Arrange
      mockScheduleService.startSessionEarly.mockResolvedValue('NOT_FOUND');

      // Act + Assert
      await expect(
        controller.startSessionEarly(
          { body: { sessionUid: 'sess-1' } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'SESSION_NOT_FOUND' });
    });

    it("throws 422 when service returns 'SESSION_IS_AUTO'", async () => {
      // Arrange
      mockScheduleService.startSessionEarly.mockResolvedValue(
        'SESSION_IS_AUTO',
      );

      // Act + Assert
      await expect(
        controller.startSessionEarly(
          { body: { sessionUid: 'sess-1' } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 422, code: 'SESSION_IS_AUTO' });
    });

    it("throws 409 when service returns 'NOT_NEXT_UPCOMING'", async () => {
      // Arrange
      mockScheduleService.startSessionEarly.mockResolvedValue(
        'NOT_NEXT_UPCOMING',
      );

      // Act + Assert
      await expect(
        controller.startSessionEarly(
          { body: { sessionUid: 'sess-1' } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'NOT_NEXT_UPCOMING',
      });
    });

    it("throws 409 when service returns 'ANOTHER_SESSION_ACTIVE'", async () => {
      // Arrange
      mockScheduleService.startSessionEarly.mockResolvedValue(
        'ANOTHER_SESSION_ACTIVE',
      );

      // Act + Assert
      await expect(
        controller.startSessionEarly(
          { body: { sessionUid: 'sess-1' } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({
        statusCode: 409,
        code: 'ANOTHER_SESSION_ACTIVE',
      });
    });

    it('returns 200 with the updated session on success', async () => {
      // Arrange
      mockScheduleService.startSessionEarly.mockResolvedValue(mockSession);

      // Act
      await controller.startSessionEarly(
        { body: { sessionUid: 'sess-1' } } as never,
        mockRes as never,
      );

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ uid: 'sess-1' }),
      );
    });
  });

  describe('endSessionEarly', (it) => {
    it("throws 404 when service returns 'NOT_FOUND'", async () => {
      // Arrange
      mockScheduleService.endSessionEarly.mockResolvedValue('NOT_FOUND');

      // Act + Assert
      await expect(
        controller.endSessionEarly(
          { body: { sessionUid: 'sess-1' } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'SESSION_NOT_FOUND' });
    });

    it("throws 422 when service returns 'SESSION_IS_AUTO'", async () => {
      // Arrange
      mockScheduleService.endSessionEarly.mockResolvedValue('SESSION_IS_AUTO');

      // Act + Assert
      await expect(
        controller.endSessionEarly(
          { body: { sessionUid: 'sess-1' } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 422, code: 'SESSION_IS_AUTO' });
    });

    it("throws 422 when service returns 'SESSION_NOT_ACTIVE'", async () => {
      // Arrange
      mockScheduleService.endSessionEarly.mockResolvedValue(
        'SESSION_NOT_ACTIVE',
      );

      // Act + Assert
      await expect(
        controller.endSessionEarly(
          { body: { sessionUid: 'sess-1' } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({
        statusCode: 422,
        code: 'SESSION_NOT_ACTIVE',
      });
    });

    it('returns 200 with the updated session on success', async () => {
      // Arrange
      mockScheduleService.endSessionEarly.mockResolvedValue(mockSession);

      // Act
      await controller.endSessionEarly(
        { body: { sessionUid: 'sess-1' } } as never,
        mockRes as never,
      );

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ uid: 'sess-1' }),
      );
    });
  });

  describe('listSchedules', (it) => {
    it('returns 200 with serialized items on success', async () => {
      // Arrange
      mockScheduleService.listSchedulesForRoom.mockResolvedValue([mockSchedule]);

      // Act
      await controller.listSchedules(
        { query: { roomUid: 'room-1' } } as never,
        mockRes as never,
      );

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith({
        items: [
          expect.objectContaining({
            uid: 'sched-1',
            activeStart: FAKE_DATE.toISOString(),
            createdAt: FAKE_DATE.toISOString(),
          }),
        ],
      });
    });

    it("throws 404 when service returns 'ROOM_NOT_FOUND'", async () => {
      // Arrange
      mockScheduleService.listSchedulesForRoom.mockResolvedValue('ROOM_NOT_FOUND');

      // Act + Assert
      await expect(
        controller.listSchedules(
          { query: { roomUid: 'room-1' } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'ROOM_NOT_FOUND' });
    });

    it('passes parsed Date bounds to the service when from/to are provided', async () => {
      // Arrange
      mockScheduleService.listSchedulesForRoom.mockResolvedValue([]);
      const from = '2026-01-01T00:00:00.000Z';
      const to = '2026-06-01T00:00:00.000Z';

      // Act
      await controller.listSchedules(
        { query: { roomUid: 'room-1', from, to } } as never,
        mockRes as never,
      );

      // Assert
      expect(mockScheduleService.listSchedulesForRoom).toHaveBeenCalledWith(
        'room-1',
        { from: new Date(from), to: new Date(to) },
      );
    });

    it('passes empty range object when from/to are omitted', async () => {
      // Arrange
      mockScheduleService.listSchedulesForRoom.mockResolvedValue([]);

      // Act
      await controller.listSchedules(
        { query: { roomUid: 'room-1' } } as never,
        mockRes as never,
      );

      // Assert
      expect(mockScheduleService.listSchedulesForRoom).toHaveBeenCalledWith(
        'room-1',
        {},
      );
    });
  });

  describe('listAutoSessionWindows', (it) => {
    it('returns 200 with serialized items on success', async () => {
      // Arrange
      mockScheduleService.listAutoSessionWindowsForRoom.mockResolvedValue([
        mockWindow,
      ]);

      // Act
      await controller.listAutoSessionWindows(
        { query: { roomUid: 'room-1' } } as never,
        mockRes as never,
      );

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith({
        items: [
          expect.objectContaining({
            uid: 'win-1',
            activeStart: FAKE_DATE.toISOString(),
            createdAt: FAKE_DATE.toISOString(),
          }),
        ],
      });
    });

    it("throws 404 when service returns 'ROOM_NOT_FOUND'", async () => {
      // Arrange
      mockScheduleService.listAutoSessionWindowsForRoom.mockResolvedValue(
        'ROOM_NOT_FOUND',
      );

      // Act + Assert
      await expect(
        controller.listAutoSessionWindows(
          { query: { roomUid: 'room-1' } } as never,
          mockRes as never,
        ),
      ).rejects.toMatchObject({ statusCode: 404, code: 'ROOM_NOT_FOUND' });
    });

    it('passes parsed Date bounds to the service when from/to are provided', async () => {
      // Arrange
      mockScheduleService.listAutoSessionWindowsForRoom.mockResolvedValue([]);
      const from = '2026-01-01T00:00:00.000Z';
      const to = '2026-06-01T00:00:00.000Z';

      // Act
      await controller.listAutoSessionWindows(
        { query: { roomUid: 'room-1', from, to } } as never,
        mockRes as never,
      );

      // Assert
      expect(
        mockScheduleService.listAutoSessionWindowsForRoom,
      ).toHaveBeenCalledWith('room-1', {
        from: new Date(from),
        to: new Date(to),
      });
    });

    it('passes empty range object when from/to are omitted', async () => {
      // Arrange
      mockScheduleService.listAutoSessionWindowsForRoom.mockResolvedValue([]);

      // Act
      await controller.listAutoSessionWindows(
        { query: { roomUid: 'room-1' } } as never,
        mockRes as never,
      );

      // Assert
      expect(
        mockScheduleService.listAutoSessionWindowsForRoom,
      ).toHaveBeenCalledWith('room-1', {});
    });
  });

  describe('mySchedule', (it) => {
    function makeReq(opts: { deviceUid?: string; sinceVersion: number }): {
      req: {
        deviceUid?: string | undefined;
        query: { sinceVersion: number };
        socket: EventEmitter;
      };
      socket: EventEmitter;
    } {
      const socket = new EventEmitter();
      return {
        req: {
          deviceUid: opts.deviceUid,
          query: { sinceVersion: opts.sinceVersion },
          socket,
        },
        socket,
      };
    }

    it('throws 500 when no deviceUid is set on the request', async () => {
      // Arrange
      const { req } = makeReq({ sinceVersion: 0 });

      // Act + Assert
      await expect(
        controller.mySchedule(req as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 500 });
    });

    it("throws 404 when room service returns 'DEVICE_NOT_IN_ROOM'", async () => {
      // Arrange
      mockRoomService.getMyRoom.mockResolvedValue('DEVICE_NOT_IN_ROOM');
      const { req } = makeReq({ deviceUid: 'd-1', sinceVersion: 0 });

      // Act + Assert
      await expect(
        controller.mySchedule(req as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 404, code: 'DEVICE_NOT_IN_ROOM' });
    });

    it('returns 200 immediately when room version is already newer than sinceVersion', async () => {
      // Arrange
      mockRoomService.getMyRoom.mockResolvedValue({
        uid: 'room-1',
        roomScheduleVersion: 5,
      });
      mockScheduleService.listActiveAndUpcomingSessions.mockResolvedValue({
        active: null,
        upcoming: [mockSession],
      });
      const { req } = makeReq({ deviceUid: 'd-1', sinceVersion: 4 });

      // Act
      await controller.mySchedule(req as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      const sent = mockSend.mock.calls[0]?.[0];
      expect(sent).toMatchObject({
        roomUid: 'room-1',
        roomScheduleVersion: 5,
        sessions: expect.any(Array),
      });
      expect(sent.sessions).toHaveLength(1);
    });

    it('publishing on the bus resolves the long-poll with 200 and the new payload', async () => {
      // Arrange
      mockRoomService.getMyRoom.mockResolvedValue({
        uid: 'room-1',
        roomScheduleVersion: 5,
      });
      mockScheduleService.listActiveAndUpcomingSessions.mockResolvedValue({
        active: mockSession,
        upcoming: [],
      });
      const { req } = makeReq({ deviceUid: 'd-1', sinceVersion: 5 });

      // Act
      const promise = controller.mySchedule(req as never, mockRes as never);
      // Wait a tick so the subscribe call inside the controller registers.
      await new Promise((r) => setImmediate(r));
      eventBus.publish(
        RoomScheduleVersionBumpedChannel,
        { roomUid: 'room-1', roomScheduleVersion: 6 },
        'room-1',
      );
      await promise;

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          roomUid: 'room-1',
          roomScheduleVersion: 6,
        }),
      );
    });

    it('responds with 204 when the socket closes before any event arrives', async () => {
      // Arrange
      mockRoomService.getMyRoom.mockResolvedValue({
        uid: 'room-1',
        roomScheduleVersion: 5,
      });
      const { req, socket } = makeReq({ deviceUid: 'd-1', sinceVersion: 5 });

      // Act
      const promise = controller.mySchedule(req as never, mockRes as never);
      await new Promise((r) => setImmediate(r));
      socket.emit('close');
      await promise;

      // Assert
      expect(mockCode).toHaveBeenCalledWith(204);
      expect(mockSend).toHaveBeenCalledWith(null);
    });
  });

  describe('sessionConfigStream', (it) => {
    function makeReq(opts: { sessionUid: string; sinceVersion: number }): {
      req: {
        params: { sessionUid: string };
        query: { sinceVersion: number };
        socket: EventEmitter;
      };
      socket: EventEmitter;
    } {
      const socket = new EventEmitter();
      return {
        req: {
          params: { sessionUid: opts.sessionUid },
          query: { sinceVersion: opts.sinceVersion },
          socket,
        },
        socket,
      };
    }

    it("throws 404 when service returns 'NOT_FOUND' on the initial fetch", async () => {
      // Arrange
      mockScheduleService.getSession.mockResolvedValue('NOT_FOUND');
      const { req } = makeReq({ sessionUid: 'sess-1', sinceVersion: 0 });

      // Act + Assert
      await expect(
        controller.sessionConfigStream(req as never, mockRes as never),
      ).rejects.toMatchObject({ statusCode: 404, code: 'SESSION_NOT_FOUND' });
    });

    it('returns 200 immediately when sessionConfigVersion already exceeds sinceVersion', async () => {
      // Arrange
      mockScheduleService.getSession.mockResolvedValue({
        ...mockSession,
        sessionConfigVersion: 5,
      });
      const { req } = makeReq({ sessionUid: 'sess-1', sinceVersion: 4 });

      // Act
      await controller.sessionConfigStream(req as never, mockRes as never);

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ uid: 'sess-1' }),
      );
    });

    it('publishing on the bus refetches and resolves with 200', async () => {
      // Arrange - initial fetch returns version 5, then bump fires, then
      // subsequent refetch returns the updated session.
      mockScheduleService.getSession
        .mockResolvedValueOnce({ ...mockSession, sessionConfigVersion: 5 })
        .mockResolvedValueOnce({ ...mockSession, sessionConfigVersion: 6 });
      const { req } = makeReq({ sessionUid: 'sess-1', sinceVersion: 5 });

      // Act
      const promise = controller.sessionConfigStream(
        req as never,
        mockRes as never,
      );
      await new Promise((r) => setImmediate(r));
      eventBus.publish(
        SessionConfigVersionBumpedChannel,
        { sessionUid: 'sess-1', sessionConfigVersion: 6 },
        'sess-1',
      );
      await promise;

      // Assert
      expect(mockCode).toHaveBeenCalledWith(200);
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ sessionConfigVersion: 6 }),
      );
    });

    it('responds with 204 when the session is deleted between bump and refetch', async () => {
      // Arrange
      mockScheduleService.getSession
        .mockResolvedValueOnce({ ...mockSession, sessionConfigVersion: 5 })
        .mockResolvedValueOnce('NOT_FOUND');
      const { req } = makeReq({ sessionUid: 'sess-1', sinceVersion: 5 });

      // Act
      const promise = controller.sessionConfigStream(
        req as never,
        mockRes as never,
      );
      await new Promise((r) => setImmediate(r));
      eventBus.publish(
        SessionConfigVersionBumpedChannel,
        { sessionUid: 'sess-1', sessionConfigVersion: 6 },
        'sess-1',
      );
      await promise;

      // Assert
      expect(mockCode).toHaveBeenCalledWith(204);
      expect(mockSend).toHaveBeenCalledWith(null);
    });

    it('responds with 204 when the socket closes before any event arrives', async () => {
      // Arrange
      mockScheduleService.getSession.mockResolvedValue({
        ...mockSession,
        sessionConfigVersion: 5,
      });
      const { req, socket } = makeReq({
        sessionUid: 'sess-1',
        sinceVersion: 5,
      });

      // Act
      const promise = controller.sessionConfigStream(
        req as never,
        mockRes as never,
      );
      await new Promise((r) => setImmediate(r));
      socket.emit('close');
      await promise;

      // Assert
      expect(mockCode).toHaveBeenCalledWith(204);
      expect(mockSend).toHaveBeenCalledWith(null);
    });
  });
});
