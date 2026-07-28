import { type Mock, beforeEach, describe, expect, vi } from 'vitest';

import type {
  DayOfWeek,
  Json,
  ScheduleFrequency,
  SessionScope,
} from '@scribear/scribear-db';

import type {
  Schedule,
  Session,
} from '#src/server/features/schedule-management/schedule-management.repository.js';
import { ScheduleManagementService } from '#src/server/features/schedule-management/schedule-management.service.js';
import {
  RoomScheduleVersionBumpedChannel,
  SessionConfigVersionBumpedChannel,
} from '#src/server/shared/events/schedule-management.events.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';

const NOW = new Date('2024-06-02T12:00:00Z');
const FUTURE = new Date('2024-06-03T00:00:00Z');
const FAR_FUTURE = new Date('2024-06-15T00:00:00Z');
const ANCHOR = new Date('2024-05-06T00:00:00Z');
const PAST = new Date('2024-06-01T00:00:00Z');
const END_A = new Date('2024-06-03T15:00:00Z');
const END_B = new Date('2024-06-03T17:00:00Z');

interface CreateInput {
  roomUid: string;
  name: string;
  activeStart: Date;
  activeEnd: Date | null;
  localStartTime: string;
  localEndTime: string;
  frequency: ScheduleFrequency;
  daysOfWeek: DayOfWeek[] | null;
  joinCodeScopes: SessionScope[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: Json;
}

function makeCreateInput(overrides: Partial<CreateInput> = {}): CreateInput {
  return {
    roomUid: 'room-1',
    name: 'Standup',
    activeStart: FUTURE,
    activeEnd: null,
    localStartTime: '09:00:00',
    localEndTime: '10:00:00',
    frequency: 'WEEKLY',
    daysOfWeek: ['MON'],
    joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
    transcriptionProviderId: 'whisper',
    transcriptionStreamConfig: {},
    ...overrides,
  };
}

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    uid: 'sched-1',
    roomUid: 'room-1',
    name: 'Standup',
    activeStart: FUTURE,
    activeEnd: null,
    anchorStart: ANCHOR,
    localStartTime: '09:00:00',
    localEndTime: '10:00:00',
    frequency: 'WEEKLY',
    daysOfWeek: ['MON'],
    joinCodeScopes: [],
    transcriptionProviderId: 'whisper',
    transcriptionStreamConfig: {},
    createdAt: NOW,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    uid: 'sess-1',
    roomUid: 'room-1',
    name: 'Session',
    type: 'SCHEDULED',
    scheduledSessionUid: 'sched-1',
    scheduledStartTime: FUTURE,
    scheduledEndTime: END_A,
    startOverride: null,
    endOverride: null,
    canceledAt: null,
    joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
    transcriptionProviderId: 'whisper',
    transcriptionStreamConfig: {},
    sessionConfigVersion: 1,
    createdAt: NOW,
    effectiveStart: FUTURE,
    effectiveEnd: END_A,
    ...overrides,
  };
}

interface MockRepo {
  db: unknown;
  lockRoom: Mock;
  findOneStaleRoomForMaterialization: Mock;
  findMaxScheduledEndForSchedule: Mock;
  updateRoomScheduleConfig: Mock;
  bumpScheduleVersion: Mock;
  touchLastMaterializedAt: Mock;
  findScheduleByUid: Mock;
  findSchedulesOverlapping: Mock;
  insertSchedule: Mock;
  updateScheduleActiveEnd: Mock;
  deleteScheduleHard: Mock;
  findWindowByUid: Mock;
  findWindowsOverlapping: Mock;
  listWindowsForRoom: Mock;
  insertWindow: Mock;
  updateWindowActiveEnd: Mock;
  deleteWindowHard: Mock;
  findLatestPastOrActiveSessionForSchedule: Mock;
  findActiveSession: Mock;
  findActiveOnDemandSession: Mock;
  findActiveAutoSession: Mock;
  findUpcomingAutoSessions: Mock;
  findNonAutoSessionsInRange: Mock;
  findNextNonAutoSessionStart: Mock;
  findSessionByUid: Mock;
  findNextUpcomingSession: Mock;
  listSessionsForRoomInRange: Mock;
  listActiveAndUpcomingSessions: Mock;
  insertSessions: Mock;
  insertSessionWithUid: Mock;
  updateSessionScheduledEnd: Mock;
  updateSessionStartOverride: Mock;
  updateSessionEndOverride: Mock;
  roomExists: Mock;
  listSchedulesForRoom: Mock;
  listOpenSchedulesForRoom: Mock;
  deleteUpcomingSessionsForSchedule: Mock;
  deleteUpcomingAutoSessions: Mock;
  setSessionsConstraintsDeferred: Mock;
}

function createMockRepo(): MockRepo {
  return {
    db: {},
    lockRoom: vi.fn().mockResolvedValue(undefined),
    findOneStaleRoomForMaterialization: vi.fn().mockResolvedValue(undefined),
    findMaxScheduledEndForSchedule: vi.fn().mockResolvedValue(null),
    updateRoomScheduleConfig: vi.fn().mockResolvedValue(undefined),
    bumpScheduleVersion: vi.fn().mockResolvedValue(1),
    touchLastMaterializedAt: vi.fn().mockResolvedValue(undefined),
    findScheduleByUid: vi.fn().mockResolvedValue(undefined),
    findSchedulesOverlapping: vi.fn().mockResolvedValue([]),
    insertSchedule: vi.fn(),
    updateScheduleActiveEnd: vi.fn().mockResolvedValue(true),
    deleteScheduleHard: vi.fn().mockResolvedValue(true),
    findWindowByUid: vi.fn().mockResolvedValue(undefined),
    findWindowsOverlapping: vi.fn().mockResolvedValue([]),
    listWindowsForRoom: vi.fn().mockResolvedValue([]),
    insertWindow: vi.fn(),
    updateWindowActiveEnd: vi.fn().mockResolvedValue(true),
    deleteWindowHard: vi.fn().mockResolvedValue(true),
    findLatestPastOrActiveSessionForSchedule: vi.fn().mockResolvedValue(undefined),
    findActiveSession: vi.fn().mockResolvedValue(undefined),
    findActiveOnDemandSession: vi.fn().mockResolvedValue(undefined),
    findActiveAutoSession: vi.fn().mockResolvedValue(undefined),
    findUpcomingAutoSessions: vi.fn().mockResolvedValue([]),
    findNonAutoSessionsInRange: vi.fn().mockResolvedValue([]),
    findNextNonAutoSessionStart: vi.fn().mockResolvedValue(null),
    findSessionByUid: vi.fn().mockResolvedValue(undefined),
    findNextUpcomingSession: vi.fn().mockResolvedValue(undefined),
    listSessionsForRoomInRange: vi.fn().mockResolvedValue([]),
    listActiveAndUpcomingSessions: vi.fn().mockResolvedValue([]),
    insertSessions: vi.fn().mockResolvedValue([]),
    insertSessionWithUid: vi.fn(),
    updateSessionScheduledEnd: vi.fn().mockResolvedValue(1),
    updateSessionStartOverride: vi.fn().mockResolvedValue(1),
    updateSessionEndOverride: vi.fn().mockResolvedValue(1),
    roomExists: vi.fn().mockResolvedValue(true),
    listSchedulesForRoom: vi.fn().mockResolvedValue([]),
    listOpenSchedulesForRoom: vi.fn().mockResolvedValue([]),
    deleteUpcomingSessionsForSchedule: vi.fn().mockResolvedValue(undefined),
    deleteUpcomingAutoSessions: vi.fn().mockResolvedValue(undefined),
    setSessionsConstraintsDeferred: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ScheduleManagementService', () => {
  let mockRepo: MockRepo;
  let mockEventBus: { publish: Mock };
  let service: ScheduleManagementService;

  beforeEach(() => {
    mockRepo = createMockRepo();
    mockEventBus = { publish: vi.fn() };
    const mockTrx = {};
    const mockDbClient = {
      db: {
        transaction: vi.fn(() => ({
          execute: vi.fn((cb: (trx: unknown) => unknown) => cb(mockTrx)),
        })),
      },
    };
    service = new ScheduleManagementService(
      createMockLogger() as never,
      mockDbClient as never,
      mockRepo as never,
      mockEventBus as never,
    );
  });

  describe('_doCreateSchedule validation codes', (it) => {
    it('returns INVALID_ACTIVE_START when activeStart equals now', async () => {
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: false,
      });

      const result = await service.createSchedule(
        makeCreateInput({ activeStart: NOW }),
        NOW,
      );

      expect(result).toBe('INVALID_ACTIVE_START');
      expect(mockRepo.insertSchedule).not.toHaveBeenCalled();
      expect(mockRepo.bumpScheduleVersion).not.toHaveBeenCalled();
    });

    it('returns INVALID_ACTIVE_START when activeStart is in the past', async () => {
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: false,
      });

      const result = await service.createSchedule(
        makeCreateInput({ activeStart: PAST }),
        NOW,
      );

      expect(result).toBe('INVALID_ACTIVE_START');
      expect(mockRepo.insertSchedule).not.toHaveBeenCalled();
      expect(mockRepo.bumpScheduleVersion).not.toHaveBeenCalled();
    });

    it('returns INVALID_LOCAL_TIMES when localStartTime equals localEndTime', async () => {
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: false,
      });

      const result = await service.createSchedule(
        makeCreateInput({ localStartTime: '09:00:00', localEndTime: '09:00:00' }),
        NOW,
      );

      expect(result).toBe('INVALID_LOCAL_TIMES');
      expect(mockRepo.insertSchedule).not.toHaveBeenCalled();
      expect(mockRepo.bumpScheduleVersion).not.toHaveBeenCalled();
    });

    it('returns INVALID_FREQUENCY_FIELDS when ONCE has non-null daysOfWeek', async () => {
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: false,
      });

      const result = await service.createSchedule(
        makeCreateInput({
          frequency: 'ONCE',
          daysOfWeek: ['MON'],
        }),
        NOW,
      );

      expect(result).toBe('INVALID_FREQUENCY_FIELDS');
      expect(mockRepo.insertSchedule).not.toHaveBeenCalled();
      expect(mockRepo.bumpScheduleVersion).not.toHaveBeenCalled();
    });

    it('returns INVALID_FREQUENCY_FIELDS when WEEKLY has null daysOfWeek', async () => {
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: false,
      });

      const result = await service.createSchedule(
        makeCreateInput({ frequency: 'WEEKLY', daysOfWeek: null }),
        NOW,
      );

      expect(result).toBe('INVALID_FREQUENCY_FIELDS');
      expect(mockRepo.insertSchedule).not.toHaveBeenCalled();
      expect(mockRepo.bumpScheduleVersion).not.toHaveBeenCalled();
    });

    it('returns INVALID_FREQUENCY_FIELDS when WEEKLY has empty daysOfWeek (array_length NULL guard)', async () => {
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: false,
      });

      const result = await service.createSchedule(
        makeCreateInput({ frequency: 'WEEKLY', daysOfWeek: [] }),
        NOW,
      );

      expect(result).toBe('INVALID_FREQUENCY_FIELDS');
      expect(mockRepo.insertSchedule).not.toHaveBeenCalled();
      expect(mockRepo.bumpScheduleVersion).not.toHaveBeenCalled();
    });

    it('returns INVALID_FREQUENCY_FIELDS when BIWEEKLY has empty daysOfWeek', async () => {
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: false,
      });

      const result = await service.createSchedule(
        makeCreateInput({ frequency: 'BIWEEKLY', daysOfWeek: [] }),
        NOW,
      );

      expect(result).toBe('INVALID_FREQUENCY_FIELDS');
      expect(mockRepo.insertSchedule).not.toHaveBeenCalled();
      expect(mockRepo.bumpScheduleVersion).not.toHaveBeenCalled();
    });

    it('returns INVALID_ACTIVE_END when activeEnd equals activeStart', async () => {
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: false,
      });

      const result = await service.createSchedule(
        makeCreateInput({ activeStart: FUTURE, activeEnd: FUTURE }),
        NOW,
      );

      expect(result).toBe('INVALID_ACTIVE_END');
      expect(mockRepo.insertSchedule).not.toHaveBeenCalled();
      expect(mockRepo.bumpScheduleVersion).not.toHaveBeenCalled();
    });

    it('returns INVALID_ACTIVE_END when activeEnd is before activeStart', async () => {
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: false,
      });

      const result = await service.createSchedule(
        makeCreateInput({ activeStart: FUTURE, activeEnd: PAST }),
        NOW,
      );

      expect(result).toBe('INVALID_ACTIVE_END');
      expect(mockRepo.insertSchedule).not.toHaveBeenCalled();
      expect(mockRepo.bumpScheduleVersion).not.toHaveBeenCalled();
    });
  });

  describe('updateSchedule anchorStart preservation', (it) => {
    it('preserves the existing anchorStart verbatim when activeStart is bumped forward (BIWEEKLY)', async () => {
      const existing = makeSchedule({
        uid: 'sched-1',
        activeStart: FUTURE,
        activeEnd: null,
        anchorStart: ANCHOR,
        frequency: 'BIWEEKLY',
        daysOfWeek: ['MON'],
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
      });
      mockRepo.findScheduleByUid.mockResolvedValue(existing);
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: false,
      });
      mockRepo.insertSchedule.mockImplementation((_trx, data) =>
        Promise.resolve({
          uid: 'sched-new',
          roomUid: data.roomUid,
          name: data.name,
          activeStart: data.activeStart,
          activeEnd: data.activeEnd,
          anchorStart: data.anchorStart,
          localStartTime: data.localStartTime,
          localEndTime: data.localEndTime,
          frequency: data.frequency,
          daysOfWeek: data.daysOfWeek,
          joinCodeScopes: data.joinCodeScopes,
          transcriptionProviderId: data.transcriptionProviderId,
          transcriptionStreamConfig: data.transcriptionStreamConfig,
          createdAt: NOW,
        }),
      );

      const result = await service.updateSchedule(
        'sched-1',
        { name: 'Updated', activeStart: FUTURE },
        NOW,
      );

      expect(result).not.toBe('NOT_FOUND');
      expect(result).not.toBe('CONFLICT');
      expect(mockRepo.insertSchedule).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ anchorStart: ANCHOR }),
      );
      expect(mockRepo.insertSchedule).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ anchorStart: FUTURE }),
      );
    });
  });

  describe('_realignActiveOnDemandSession guard', (it) => {
    it('bumps scheduled_end_time when the next non-auto session start has changed', async () => {
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: true,
      });
      mockRepo.findActiveOnDemandSession.mockResolvedValue(
        makeSession({
          uid: 'od-1',
          type: 'ON_DEMAND',
          scheduledSessionUid: null,
          effectiveStart: NOW,
          effectiveEnd: END_A,
        }),
      );
      mockRepo.findNextNonAutoSessionStart.mockResolvedValue(END_B);
      mockRepo.updateSessionScheduledEnd.mockResolvedValue(5);
      mockRepo.bumpScheduleVersion.mockResolvedValue(2);

      await service.updateRoomScheduleConfig(
        'room-1',
        { autoSessionEnabled: false },
        NOW,
      );

      expect(mockRepo.updateSessionScheduledEnd).toHaveBeenCalledWith(
        expect.anything(),
        'od-1',
        END_B,
      );
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        SessionConfigVersionBumpedChannel,
        { sessionUid: 'od-1', sessionConfigVersion: 5 },
        'od-1',
      );
    });

    it('does NOT bump scheduled_end_time when the end is unchanged', async () => {
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: true,
      });
      mockRepo.findActiveOnDemandSession.mockResolvedValue(
        makeSession({
          uid: 'od-1',
          type: 'ON_DEMAND',
          scheduledSessionUid: null,
          effectiveStart: NOW,
          effectiveEnd: END_A,
        }),
      );
      mockRepo.findNextNonAutoSessionStart.mockResolvedValue(END_A);

      await service.updateRoomScheduleConfig(
        'room-1',
        { autoSessionEnabled: false },
        NOW,
      );

      expect(mockRepo.updateSessionScheduledEnd).not.toHaveBeenCalled();
      expect(mockEventBus.publish).not.toHaveBeenCalledWith(
        SessionConfigVersionBumpedChannel,
        expect.anything(),
        'od-1',
      );
    });

    it('does NOT bump when both current end and next start are null (open-ended unchanged)', async () => {
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: true,
      });
      mockRepo.findActiveOnDemandSession.mockResolvedValue(
        makeSession({
          uid: 'od-1',
          type: 'ON_DEMAND',
          scheduledSessionUid: null,
          effectiveStart: NOW,
          effectiveEnd: null,
        }),
      );
      mockRepo.findNextNonAutoSessionStart.mockResolvedValue(null);

      await service.updateRoomScheduleConfig(
        'room-1',
        { autoSessionEnabled: false },
        NOW,
      );

      expect(mockRepo.updateSessionScheduledEnd).not.toHaveBeenCalled();
    });
  });

  describe('_runWithEvents / _publishEvents post-commit invariant', (it) => {
    it('does NOT publish events when the transaction rolls back via RollbackError', async () => {
      const existing = makeSchedule({
        uid: 'sched-1',
        activeStart: FUTURE,
        activeEnd: null,
        anchorStart: ANCHOR,
        frequency: 'BIWEEKLY',
        daysOfWeek: ['MON'],
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
      });
      mockRepo.findScheduleByUid.mockResolvedValue(existing);
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: false,
      });
      mockRepo.findActiveOnDemandSession.mockResolvedValue(
        makeSession({
          uid: 'od-1',
          type: 'ON_DEMAND',
          scheduledSessionUid: null,
          effectiveStart: NOW,
          effectiveEnd: END_A,
        }),
      );
      mockRepo.findNextNonAutoSessionStart.mockResolvedValue(END_B);
      mockRepo.updateSessionScheduledEnd.mockResolvedValue(3);

      const result = await service.updateSchedule(
        'sched-1',
        { activeStart: PAST },
        NOW,
      );

      expect(result).toBe('INVALID_ACTIVE_START');
      expect(mockEventBus.publish).not.toHaveBeenCalled();
    });

    it('does NOT publish events when the transaction throws a real error', async () => {
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: false,
      });
      mockRepo.findSchedulesOverlapping.mockResolvedValue([]);
      mockRepo.insertSchedule.mockRejectedValue(new Error('DB connection lost'));

      await expect(
        service.createSchedule(makeCreateInput({ activeStart: FUTURE }), NOW),
      ).rejects.toThrow('DB connection lost');

      expect(mockEventBus.publish).not.toHaveBeenCalled();
    });

    it('publishes a room bump event on successful commit', async () => {
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: false,
      });
      mockRepo.findSchedulesOverlapping.mockResolvedValue([]);
      mockRepo.insertSchedule.mockImplementation((_trx, data) =>
        Promise.resolve({
          uid: 'sched-new',
          roomUid: data.roomUid,
          name: data.name,
          activeStart: data.activeStart,
          activeEnd: data.activeEnd,
          anchorStart: data.anchorStart,
          localStartTime: data.localStartTime,
          localEndTime: data.localEndTime,
          frequency: data.frequency,
          daysOfWeek: data.daysOfWeek,
          joinCodeScopes: data.joinCodeScopes,
          transcriptionProviderId: data.transcriptionProviderId,
          transcriptionStreamConfig: data.transcriptionStreamConfig,
          createdAt: NOW,
        }),
      );
      mockRepo.bumpScheduleVersion.mockResolvedValue(2);

      const result = await service.createSchedule(
        makeCreateInput({ activeStart: FAR_FUTURE }),
        NOW,
      );

      expect(typeof result).toBe('object');
      expect(mockEventBus.publish).toHaveBeenCalledWith(
        RoomScheduleVersionBumpedChannel,
        { roomUid: 'room-1', roomScheduleVersion: 2 },
        'room-1',
      );
    });
  });

  describe('createOnDemandSession preconditions', (it) => {
    const onDemandInput = {
      roomUid: 'room-1',
      name: 'Quick Meeting',
      joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'] as SessionScope[],
      transcriptionProviderId: 'whisper',
      transcriptionStreamConfig: {} as Json,
    };

    it('returns ROOM_NOT_FOUND when the room does not exist', async () => {
      mockRepo.lockRoom.mockResolvedValue(undefined);

      const result = await service.createOnDemandSession(onDemandInput, NOW);

      expect(result).toBe('ROOM_NOT_FOUND');
    });

    it('returns ANOTHER_SESSION_ACTIVE when a non-AUTO session is currently active', async () => {
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: false,
      });
      mockRepo.findActiveSession.mockResolvedValue(
        makeSession({ uid: 'active-1', type: 'SCHEDULED' }),
      );

      const result = await service.createOnDemandSession(onDemandInput, NOW);

      expect(result).toBe('ANOTHER_SESSION_ACTIVE');
      expect(mockRepo.setSessionsConstraintsDeferred).not.toHaveBeenCalled();
      expect(mockRepo.insertSessions).not.toHaveBeenCalled();
    });
  });

  describe('startSessionEarly preconditions', (it) => {
    it('returns NOT_FOUND when the session does not exist', async () => {
      mockRepo.findSessionByUid.mockResolvedValue(undefined);

      const result = await service.startSessionEarly('sess-1', NOW);

      expect(result).toBe('NOT_FOUND');
    });

    it('returns SESSION_IS_AUTO for an AUTO session', async () => {
      mockRepo.findSessionByUid.mockResolvedValue(
        makeSession({ uid: 'sess-1', type: 'AUTO' }),
      );

      const result = await service.startSessionEarly('sess-1', NOW);

      expect(result).toBe('SESSION_IS_AUTO');
      expect(mockRepo.lockRoom).not.toHaveBeenCalled();
    });

    it('returns NOT_NEXT_UPCOMING when a different session is next upcoming', async () => {
      mockRepo.findSessionByUid.mockResolvedValue(
        makeSession({ uid: 'sess-1', type: 'SCHEDULED', roomUid: 'room-1' }),
      );
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: false,
      });
      mockRepo.findNextUpcomingSession.mockResolvedValue(
        makeSession({ uid: 'other-session', type: 'SCHEDULED' }),
      );

      const result = await service.startSessionEarly('sess-1', NOW);

      expect(result).toBe('NOT_NEXT_UPCOMING');
      expect(mockRepo.findActiveSession).not.toHaveBeenCalled();
    });

    it('returns NOT_NEXT_UPCOMING when there is no next upcoming session', async () => {
      mockRepo.findSessionByUid.mockResolvedValue(
        makeSession({ uid: 'sess-1', type: 'SCHEDULED', roomUid: 'room-1' }),
      );
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: false,
      });
      mockRepo.findNextUpcomingSession.mockResolvedValue(undefined);

      const result = await service.startSessionEarly('sess-1', NOW);

      expect(result).toBe('NOT_NEXT_UPCOMING');
    });

    it('returns ANOTHER_SESSION_ACTIVE when a non-AUTO session is currently active', async () => {
      mockRepo.findSessionByUid.mockResolvedValue(
        makeSession({ uid: 'sess-1', type: 'SCHEDULED', roomUid: 'room-1' }),
      );
      mockRepo.lockRoom.mockResolvedValue({
        uid: 'room-1',
        timezone: 'UTC',
        autoSessionEnabled: false,
      });
      mockRepo.findNextUpcomingSession.mockResolvedValue(
        makeSession({ uid: 'sess-1', type: 'SCHEDULED' }),
      );
      mockRepo.findActiveSession.mockResolvedValue(
        makeSession({ uid: 'active-1', type: 'SCHEDULED' }),
      );

      const result = await service.startSessionEarly('sess-1', NOW);

      expect(result).toBe('ANOTHER_SESSION_ACTIVE');
      expect(mockRepo.setSessionsConstraintsDeferred).not.toHaveBeenCalled();
    });
  });
});
