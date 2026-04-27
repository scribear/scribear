import { beforeEach, describe, expect } from 'vitest';

import { ScheduleManagementRepository } from '#src/server/features/schedule-management/schedule-management.repository.js';
import { useDb } from '#tests/utils/use-db.js';

const NULL_UUID = '00000000-0000-0000-0000-000000000000';

describe('ScheduleManagementRepository', () => {
  // FK-safe truncate order; rooms cascade to children otherwise.
  const dbContext = useDb([
    'sessions',
    'session_schedules',
    'auto_session_windows',
    'rooms',
  ]);
  let repository: ScheduleManagementRepository;

  beforeEach(() => {
    repository = new ScheduleManagementRepository(dbContext.dbClient);
  });

  async function insertRoom(
    timezone = 'America/New_York',
    autoSessionEnabled = true,
  ) {
    return dbContext.db
      .insertInto('rooms')
      .values({
        name: 'Test Room',
        timezone,
        auto_session_enabled: autoSessionEnabled,
      })
      .returning(['uid', 'room_schedule_version'])
      .executeTakeFirstOrThrow();
  }

  async function getRoomVersion(roomUid: string): Promise<number> {
    const row = await dbContext.db
      .selectFrom('rooms')
      .select('room_schedule_version')
      .where('uid', '=', roomUid)
      .executeTakeFirstOrThrow();
    return Number(row.room_schedule_version);
  }

  describe('lockRoom', (it) => {
    it('returns the room identity, timezone, and auto-session master switch', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom('Europe/London', false);

      // Act
      const result = await dbContext.db
        .transaction()
        .execute((trx) => repository.lockRoom(trx, roomUid));

      // Assert
      expect(result).toEqual({
        uid: roomUid,
        timezone: 'Europe/London',
        autoSessionEnabled: false,
      });
    });

    it('returns undefined for a missing room', async () => {
      // Arrange / Act
      const result = await dbContext.db
        .transaction()
        .execute((trx) => repository.lockRoom(trx, NULL_UUID));

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('bumpScheduleVersion', (it) => {
    it('increments the version by one', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      const before = await getRoomVersion(roomUid);

      // Act
      await dbContext.db
        .transaction()
        .execute((trx) => repository.bumpScheduleVersion(trx, roomUid));

      // Assert
      expect(await getRoomVersion(roomUid)).toBe(before + 1);
    });
  });

  describe('touchLastMaterializedAt', (it) => {
    it('writes the supplied timestamp', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      const now = new Date('2024-06-01T12:00:00Z');

      // Act
      await dbContext.db
        .transaction()
        .execute((trx) =>
          repository.touchLastMaterializedAt(trx, roomUid, now),
        );

      // Assert
      const row = await dbContext.db
        .selectFrom('rooms')
        .select('last_materialized_at')
        .where('uid', '=', roomUid)
        .executeTakeFirstOrThrow();
      expect(row.last_materialized_at).toEqual(now);
    });
  });

  describe('insertSchedule + findScheduleByUid', (it) => {
    it('round-trips fields for a ONCE schedule', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      const activeStart = new Date('2024-09-01T12:00:00Z');

      // Act
      const created = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'Lecture',
        activeStart,
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
        activeEnd: null,
        joinCodeScopes: [],
      });
      const found = await repository.findScheduleByUid(
        repository.db,
        created.uid,
      );

      // Assert
      expect(found).toEqual(created);
      expect(created.activeStart).toEqual(activeStart);
      expect(created.activeEnd).toBeNull();
      expect(created.joinCodeScopes).toEqual([]);
    });

    it('persists WEEKLY days_of_week and join_code_scopes via parsePgEnumArray', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();

      // Act
      const created = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'Standup',
        activeStart: new Date('2024-09-01T00:00:00Z'),
        localStartTime: '09:00:00',
        localEndTime: '09:30:00',
        frequency: 'WEEKLY',
        daysOfWeek: ['MON', 'WED', 'FRI'],
        joinCodeScopes: ['SEND_AUDIO'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
        activeEnd: null,
      });
      const found = await repository.findScheduleByUid(
        repository.db,
        created.uid,
      );

      // Assert - array shape preserved through pg's enum-array string format.
      expect(found!.daysOfWeek).toEqual(['MON', 'WED', 'FRI']);
      expect(found!.joinCodeScopes).toEqual(['SEND_AUDIO']);
    });

    it('returns undefined when the schedule does not exist', async () => {
      // Arrange / Act
      const result = await repository.findScheduleByUid(
        repository.db,
        NULL_UUID,
      );

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('findSchedulesOverlapping', (it) => {
    it('includes schedules with active_end IS NULL whose active_start < range.to', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      const a = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'A',
        activeStart: new Date('2024-01-01T00:00:00Z'),
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
        activeEnd: null,
        joinCodeScopes: [],
      });

      // Act
      const found = await repository.findSchedulesOverlapping(
        repository.db,
        roomUid,
        { from: new Date('2024-06-01T00:00:00Z'), to: null },
      );

      // Assert
      expect(found.map((s) => s.uid)).toEqual([a.uid]);
    });

    it('excludes schedules whose active_end is at or before range.from', async () => {
      // Arrange - closed schedule with active_end = 2024-06-01.
      const { uid: roomUid } = await insertRoom();
      await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'Closed',
        activeStart: new Date('2024-01-01T00:00:00Z'),
        activeEnd: new Date('2024-06-01T00:00:00Z'),
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
        joinCodeScopes: [],
      });

      // Act - query at the close instant — strict `>` filter excludes equal end.
      const found = await repository.findSchedulesOverlapping(
        repository.db,
        roomUid,
        { from: new Date('2024-06-01T00:00:00Z'), to: null },
      );

      // Assert
      expect(found).toHaveLength(0);
    });

    it('excludes schedules whose active_start is at or beyond range.to', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'Future',
        activeStart: new Date('2024-12-01T00:00:00Z'),
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
        activeEnd: null,
        joinCodeScopes: [],
      });

      // Act - query strictly before active_start.
      const found = await repository.findSchedulesOverlapping(
        repository.db,
        roomUid,
        {
          from: new Date('2024-06-01T00:00:00Z'),
          to: new Date('2024-12-01T00:00:00Z'),
        },
      );

      // Assert - active_start < to is strict, so equal is excluded.
      expect(found).toHaveLength(0);
    });

    it('honors excludeUid', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      const a = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'A',
        activeStart: new Date('2024-01-01T00:00:00Z'),
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
        activeEnd: null,
        joinCodeScopes: [],
      });
      const b = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'B',
        activeStart: new Date('2024-01-01T00:00:00Z'),
        localStartTime: '11:00:00',
        localEndTime: '12:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
        activeEnd: null,
        joinCodeScopes: [],
      });

      // Act
      const found = await repository.findSchedulesOverlapping(
        repository.db,
        roomUid,
        { from: new Date('2024-01-01T00:00:00Z'), to: null },
        { excludeUid: a.uid },
      );

      // Assert
      expect(found.map((s) => s.uid)).toEqual([b.uid]);
    });
  });

  describe('updateScheduleActiveEnd', (it) => {
    it('sets active_end on an open schedule and returns true', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      const created = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'Open',
        activeStart: new Date('2024-01-01T00:00:00Z'),
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
        activeEnd: null,
        joinCodeScopes: [],
      });
      const closeAt = new Date('2024-06-01T12:00:00Z');

      // Act
      const result = await repository.updateScheduleActiveEnd(
        repository.db,
        created.uid,
        closeAt,
      );

      // Assert
      expect(result).toBe(true);
      const found = await repository.findScheduleByUid(
        repository.db,
        created.uid,
      );
      expect(found!.activeEnd).toEqual(closeAt);
    });

    it('returns false when the schedule is already closed', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      const created = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'Closed',
        activeStart: new Date('2024-01-01T00:00:00Z'),
        activeEnd: new Date('2024-03-01T00:00:00Z'),
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
        joinCodeScopes: [],
      });

      // Act
      const result = await repository.updateScheduleActiveEnd(
        repository.db,
        created.uid,
        new Date('2024-06-01T00:00:00Z'),
      );

      // Assert - row was already closed, no-op.
      expect(result).toBe(false);
    });
  });

  describe('deleteScheduleHard', (it) => {
    it('hard-deletes the row and cascades to sessions', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      const schedule = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'S',
        activeStart: new Date('2024-01-01T00:00:00Z'),
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
        activeEnd: null,
        joinCodeScopes: [],
      });
      await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Child Session',
          type: 'SCHEDULED',
          scheduled_session_uid: schedule.uid,
          scheduled_start_time: new Date('2024-09-01T09:00:00Z'),
          scheduled_end_time: new Date('2024-09-01T10:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .execute();

      // Act
      const result = await repository.deleteScheduleHard(
        repository.db,
        schedule.uid,
      );

      // Assert
      expect(result).toBe(true);
      expect(
        await repository.findScheduleByUid(repository.db, schedule.uid),
      ).toBeUndefined();
      const remaining = await dbContext.db
        .selectFrom('sessions')
        .select('uid')
        .where('scheduled_session_uid', '=', schedule.uid)
        .execute();
      expect(remaining).toHaveLength(0);
    });

    it('returns false when the schedule does not exist', async () => {
      // Arrange / Act
      const result = await repository.deleteScheduleHard(
        repository.db,
        NULL_UUID,
      );

      // Assert
      expect(result).toBe(false);
    });
  });

  describe('window CRUD primitives', (it) => {
    it('insert + find returns the same row', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();

      // Act
      const created = await repository.insertWindow(repository.db, {
        roomUid,
        localStartTime: '08:00:00',
        localEndTime: '18:00:00',
        daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
        activeStart: new Date('2024-01-01T00:00:00Z'),
        activeEnd: null,
      });
      const found = await repository.findWindowByUid(
        repository.db,
        created.uid,
      );

      // Assert
      expect(found).toEqual(created);
      expect(created.daysOfWeek).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI']);
    });

    it('findWindowsOverlapping respects active_end and excludeUid', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      const open = await repository.insertWindow(repository.db, {
        roomUid,
        localStartTime: '08:00:00',
        localEndTime: '12:00:00',
        daysOfWeek: ['MON'],
        activeStart: new Date('2024-01-01T00:00:00Z'),
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
        activeEnd: null,
      });
      await repository.insertWindow(repository.db, {
        roomUid,
        localStartTime: '13:00:00',
        localEndTime: '17:00:00',
        daysOfWeek: ['TUE'],
        activeStart: new Date('2024-01-01T00:00:00Z'),
        activeEnd: new Date('2024-06-01T00:00:00Z'),
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      });

      // Act
      const found = await repository.findWindowsOverlapping(
        repository.db,
        roomUid,
        { from: new Date('2024-06-01T00:00:00Z'), to: null },
      );

      // Assert - closed window excluded; open window returned.
      expect(found.map((w) => w.uid)).toEqual([open.uid]);
    });

    it('updateWindowActiveEnd is a no-op on already-closed rows', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      const created = await repository.insertWindow(repository.db, {
        roomUid,
        localStartTime: '08:00:00',
        localEndTime: '12:00:00',
        daysOfWeek: ['MON'],
        activeStart: new Date('2024-01-01T00:00:00Z'),
        activeEnd: new Date('2024-03-01T00:00:00Z'),
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      });

      // Act
      const result = await repository.updateWindowActiveEnd(
        repository.db,
        created.uid,
        new Date('2024-06-01T00:00:00Z'),
      );

      // Assert
      expect(result).toBe(false);
    });

    it('deleteWindowHard removes the row', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      const created = await repository.insertWindow(repository.db, {
        roomUid,
        localStartTime: '08:00:00',
        localEndTime: '12:00:00',
        daysOfWeek: ['MON'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
        activeStart: new Date('2024-01-01T00:00:00Z'),
        activeEnd: null,
      });

      // Act
      const result = await repository.deleteWindowHard(
        repository.db,
        created.uid,
      );

      // Assert
      expect(result).toBe(true);
      expect(
        await repository.findWindowByUid(repository.db, created.uid),
      ).toBeUndefined();
    });
  });

  describe('findLatestPastOrActiveSessionForSchedule', (it) => {
    it('picks the latest realized session by effective start', async () => {
      // Arrange
      const now = new Date('2024-06-01T15:00:00Z');
      const { uid: roomUid } = await insertRoom();
      const schedule = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'S',
        activeStart: new Date('2024-01-01T00:00:00Z'),
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'WEEKLY',
        daysOfWeek: ['MON'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
        activeEnd: null,
        joinCodeScopes: [],
      });
      // Earlier realized session
      await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Old',
          type: 'SCHEDULED',
          scheduled_session_uid: schedule.uid,
          scheduled_start_time: new Date('2024-05-01T09:00:00Z'),
          scheduled_end_time: new Date('2024-05-01T10:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .execute();
      // Currently active session
      await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Active',
          type: 'SCHEDULED',
          scheduled_session_uid: schedule.uid,
          scheduled_start_time: new Date('2024-06-01T14:00:00Z'),
          scheduled_end_time: new Date('2024-06-01T16:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .execute();

      // Act
      const result = await repository.findLatestPastOrActiveSessionForSchedule(
        repository.db,
        schedule.uid,
        now,
      );

      // Assert - the active one is the latest; effective end matches.
      expect(result?.effectiveEnd).toEqual(new Date('2024-06-01T16:00:00Z'));
    });

    it('excludes sessions whose effectiveStart is in the future', async () => {
      // Arrange
      const now = new Date('2024-06-01T08:00:00Z');
      const { uid: roomUid } = await insertRoom();
      const schedule = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'S',
        activeStart: new Date('2024-01-01T00:00:00Z'),
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
        activeEnd: null,
        joinCodeScopes: [],
      });
      await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Future',
          type: 'SCHEDULED',
          scheduled_session_uid: schedule.uid,
          scheduled_start_time: new Date('2024-06-01T09:00:00Z'),
          scheduled_end_time: new Date('2024-06-01T10:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .execute();

      // Act
      const result = await repository.findLatestPastOrActiveSessionForSchedule(
        repository.db,
        schedule.uid,
        now,
      );

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('findActiveOnDemandSession / findActiveAutoSession', (it) => {
    it('returns the active session of the requested type', async () => {
      // Arrange
      const now = new Date('2024-06-01T12:00:00Z');
      const { uid: roomUid } = await insertRoom();
      await dbContext.db
        .insertInto('sessions')
        .values([
          {
            room_uid: roomUid,
            name: 'On-demand',
            type: 'ON_DEMAND',
            scheduled_start_time: new Date('2024-06-01T11:00:00Z'),
            scheduled_end_time: new Date('2024-06-01T13:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
        ])
        .execute();
      await dbContext.db
        .insertInto('sessions')
        .values([
          {
            room_uid: roomUid,
            name: 'Auto-past',
            type: 'AUTO',
            scheduled_start_time: new Date('2024-06-01T08:00:00Z'),
            scheduled_end_time: new Date('2024-06-01T11:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
        ])
        .execute();

      // Act
      const onDemand = await repository.findActiveOnDemandSession(
        repository.db,
        roomUid,
        now,
      );
      const auto = await repository.findActiveAutoSession(
        repository.db,
        roomUid,
        now,
      );

      // Assert
      expect(onDemand?.name).toBe('On-demand');
      expect(auto).toBeUndefined();
    });
  });

  describe('findNonAutoSessionsInRange', (it) => {
    it('includes SCHEDULED and ON_DEMAND, excludes AUTO, respects overlap', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      await dbContext.db
        .insertInto('sessions')
        .values([
          {
            room_uid: roomUid,
            name: 'In-range scheduled',
            type: 'SCHEDULED',
            scheduled_session_uid: (
              await repository.insertSchedule(repository.db, {
                roomUid,
                name: 'X',
                activeStart: new Date('2024-01-01T00:00:00Z'),
                localStartTime: '09:00:00',
                localEndTime: '10:00:00',
                frequency: 'ONCE',
                daysOfWeek: null,
                transcriptionProviderId: 'whisper',
                transcriptionStreamConfig: {},
                activeEnd: null,
                joinCodeScopes: [],
              })
            ).uid,
            scheduled_start_time: new Date('2024-06-01T10:00:00Z'),
            scheduled_end_time: new Date('2024-06-01T11:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
          {
            room_uid: roomUid,
            name: 'In-range on-demand',
            type: 'ON_DEMAND',
            scheduled_start_time: new Date('2024-06-01T12:00:00Z'),
            scheduled_end_time: new Date('2024-06-01T13:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
          {
            room_uid: roomUid,
            name: 'Excluded auto',
            type: 'AUTO',
            scheduled_start_time: new Date('2024-06-01T11:00:00Z'),
            scheduled_end_time: new Date('2024-06-01T12:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
        ])
        .execute();

      // Act
      const found = await repository.findNonAutoSessionsInRange(
        repository.db,
        roomUid,
        {
          from: new Date('2024-06-01T09:00:00Z'),
          to: new Date('2024-06-01T14:00:00Z'),
        },
      );

      // Assert
      expect(found.map((s) => s.name).sort()).toEqual([
        'In-range on-demand',
        'In-range scheduled',
      ]);
    });
  });

  describe('findNextNonAutoSessionStart', (it) => {
    it('returns the next SCHEDULED session start strictly after `after`', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      const schedule = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'S',
        activeStart: new Date('2024-01-01T00:00:00Z'),
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
        activeEnd: null,
        joinCodeScopes: [],
      });
      const start = new Date('2024-06-01T15:00:00Z');
      await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Next',
          type: 'SCHEDULED',
          scheduled_session_uid: schedule.uid,
          scheduled_start_time: start,
          scheduled_end_time: new Date('2024-06-01T16:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .execute();

      // Act
      const result = await repository.findNextNonAutoSessionStart(
        repository.db,
        roomUid,
        new Date('2024-06-01T12:00:00Z'),
      );

      // Assert
      expect(result).toEqual(start);
    });

    it('returns null when no future SCHEDULED session exists', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();

      // Act
      const result = await repository.findNextNonAutoSessionStart(
        repository.db,
        roomUid,
        new Date(),
      );

      // Assert
      expect(result).toBeNull();
    });
  });

  describe('listSessionsForRoomInRange', (it) => {
    it('includes sessions that straddle either boundary, ordered by effective start', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      await dbContext.db
        .insertInto('sessions')
        .values([
          {
            room_uid: roomUid,
            name: 'Early straddle',
            type: 'ON_DEMAND',
            scheduled_start_time: new Date('2024-06-01T11:00:00Z'),
            scheduled_end_time: new Date('2024-06-01T13:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
          {
            room_uid: roomUid,
            name: 'Late straddle',
            type: 'ON_DEMAND',
            scheduled_start_time: new Date('2024-06-01T14:00:00Z'),
            scheduled_end_time: new Date('2024-06-01T16:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
          {
            room_uid: roomUid,
            name: 'Outside before',
            type: 'ON_DEMAND',
            scheduled_start_time: new Date('2024-06-01T08:00:00Z'),
            scheduled_end_time: new Date('2024-06-01T09:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
        ])
        .execute();

      // Act
      const found = await repository.listSessionsForRoomInRange(
        repository.db,
        roomUid,
        {
          from: new Date('2024-06-01T12:00:00Z'),
          to: new Date('2024-06-01T15:00:00Z'),
        },
      );

      // Assert - ordering by effectiveStart ascending; both straddlers included.
      expect(found.map((s) => s.name)).toEqual([
        'Early straddle',
        'Late straddle',
      ]);
    });
  });

  describe('listActiveAndUpcomingSessions', (it) => {
    it('returns active + upcoming up to horizon, excludes past and beyond', async () => {
      // Arrange
      const now = new Date('2024-06-01T12:00:00Z');
      const upTo = new Date('2024-06-01T18:00:00Z');
      const { uid: roomUid } = await insertRoom();
      await dbContext.db
        .insertInto('sessions')
        .values([
          {
            room_uid: roomUid,
            name: 'Past',
            type: 'ON_DEMAND',
            scheduled_start_time: new Date('2024-06-01T08:00:00Z'),
            scheduled_end_time: new Date('2024-06-01T09:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
          {
            room_uid: roomUid,
            name: 'Active',
            type: 'ON_DEMAND',
            scheduled_start_time: new Date('2024-06-01T11:00:00Z'),
            scheduled_end_time: new Date('2024-06-01T13:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
          {
            room_uid: roomUid,
            name: 'Upcoming-in',
            type: 'ON_DEMAND',
            scheduled_start_time: new Date('2024-06-01T14:00:00Z'),
            scheduled_end_time: new Date('2024-06-01T15:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
          {
            room_uid: roomUid,
            name: 'Upcoming-out',
            type: 'ON_DEMAND',
            scheduled_start_time: new Date('2024-06-01T20:00:00Z'),
            scheduled_end_time: new Date('2024-06-01T21:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
        ])
        .execute();

      // Act
      const found = await repository.listActiveAndUpcomingSessions(
        repository.db,
        roomUid,
        now,
        upTo,
      );

      // Assert
      expect(found.map((s) => s.name)).toEqual(['Active', 'Upcoming-in']);
    });
  });

  describe('insertSessions / updateSessionScheduledEnd / updateSessionEndOverride', (it) => {
    it('batch inserts and bumps session_config_version on update', async () => {
      // Arrange - two non-overlapping sessions an hour apart.
      const { uid: roomUid } = await insertRoom();
      const inserted = await repository.insertSessions(repository.db, [
        {
          roomUid,
          name: 'A',
          type: 'ON_DEMAND',
          scheduledSessionUid: null,
          scheduledStartTime: new Date('2024-06-01T09:00:00Z'),
          scheduledEndTime: new Date('2024-06-01T10:00:00Z'),
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
          joinCodeScopes: [],
        },
        {
          roomUid,
          name: 'B',
          type: 'ON_DEMAND',
          scheduledSessionUid: null,
          scheduledStartTime: new Date('2024-06-01T11:00:00Z'),
          scheduledEndTime: new Date('2024-06-01T12:00:00Z'),
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
          joinCodeScopes: [],
        },
      ]);
      const versionBefore = inserted[0]!.sessionConfigVersion;

      // Act - update each session's end (within its own original interval, so
      // no overlap). Both updates should bump session_config_version.
      await repository.updateSessionScheduledEnd(
        repository.db,
        inserted[0]!.uid,
        new Date('2024-06-01T09:45:00Z'),
      );
      await repository.updateSessionEndOverride(
        repository.db,
        inserted[1]!.uid,
        new Date('2024-06-01T11:45:00Z'),
      );

      // Assert
      const fetched = await dbContext.db
        .selectFrom('sessions')
        .select(['uid', 'session_config_version'])
        .where('uid', 'in', [inserted[0]!.uid, inserted[1]!.uid])
        .execute();
      for (const row of fetched) {
        expect(Number(row.session_config_version)).toBeGreaterThan(
          versionBefore,
        );
      }
    });

    it('insertSessions returns an empty array for no rows', async () => {
      // Arrange / Act
      const result = await repository.insertSessions(repository.db, []);

      // Assert
      expect(result).toEqual([]);
    });
  });

  describe('deleteUpcomingSessionsForSchedule / deleteUpcomingAutoSessions', (it) => {
    it('deletes only future sessions for the given schedule', async () => {
      // Arrange
      const now = new Date('2024-06-01T12:00:00Z');
      const { uid: roomUid } = await insertRoom();
      const schedule = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'S',
        activeStart: new Date('2024-01-01T00:00:00Z'),
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'WEEKLY',
        daysOfWeek: ['MON'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
        activeEnd: null,
        joinCodeScopes: [],
      });
      await dbContext.db
        .insertInto('sessions')
        .values([
          {
            room_uid: roomUid,
            name: 'Past',
            type: 'SCHEDULED',
            scheduled_session_uid: schedule.uid,
            scheduled_start_time: new Date('2024-05-01T09:00:00Z'),
            scheduled_end_time: new Date('2024-05-01T10:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
          {
            room_uid: roomUid,
            name: 'Future',
            type: 'SCHEDULED',
            scheduled_session_uid: schedule.uid,
            scheduled_start_time: new Date('2024-06-15T09:00:00Z'),
            scheduled_end_time: new Date('2024-06-15T10:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
        ])
        .execute();

      // Act
      await repository.deleteUpcomingSessionsForSchedule(
        repository.db,
        schedule.uid,
        now,
      );

      // Assert - past kept, future removed.
      const remaining = await dbContext.db
        .selectFrom('sessions')
        .select('name')
        .where('scheduled_session_uid', '=', schedule.uid)
        .execute();
      expect(remaining.map((r) => r.name)).toEqual(['Past']);
    });

    it('deleteUpcomingAutoSessions only removes AUTO future sessions', async () => {
      // Arrange
      const now = new Date('2024-06-01T12:00:00Z');
      const { uid: roomUid } = await insertRoom();
      await dbContext.db
        .insertInto('sessions')
        .values([
          {
            room_uid: roomUid,
            name: 'Past auto',
            type: 'AUTO',
            scheduled_start_time: new Date('2024-05-01T09:00:00Z'),
            scheduled_end_time: new Date('2024-05-01T10:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
          {
            room_uid: roomUid,
            name: 'Future auto',
            type: 'AUTO',
            scheduled_start_time: new Date('2024-06-15T09:00:00Z'),
            scheduled_end_time: new Date('2024-06-15T10:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
          {
            room_uid: roomUid,
            name: 'Future on-demand',
            type: 'ON_DEMAND',
            scheduled_start_time: new Date('2024-06-15T11:00:00Z'),
            scheduled_end_time: new Date('2024-06-15T12:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
        ])
        .execute();

      // Act
      await repository.deleteUpcomingAutoSessions(repository.db, roomUid, now);

      // Assert - only future AUTO removed; ON_DEMAND and past AUTO preserved.
      const remaining = await dbContext.db
        .selectFrom('sessions')
        .select('name')
        .where('room_uid', '=', roomUid)
        .execute();
      expect(remaining.map((r) => r.name).sort()).toEqual([
        'Future on-demand',
        'Past auto',
      ]);
    });
  });

  describe('setSessionsConstraintsDeferred', (it) => {
    it('allows transient overlap inside a transaction (then rolls back)', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom();
      const start = new Date('2024-06-01T09:00:00Z');
      const end = new Date('2024-06-01T10:00:00Z');

      // Act / Assert - with deferred constraint, two overlapping inserts
      // succeed within a transaction; rolling back keeps the table empty.
      await expect(
        dbContext.db.transaction().execute(async (trx) => {
          await repository.setSessionsConstraintsDeferred(trx);
          await trx
            .insertInto('sessions')
            .values([
              {
                room_uid: roomUid,
                name: 'A',
                type: 'ON_DEMAND',
                scheduled_start_time: start,
                scheduled_end_time: end,
                transcription_provider_id: 'whisper',
                transcription_stream_config: {},
              },
              {
                room_uid: roomUid,
                name: 'B',
                type: 'ON_DEMAND',
                scheduled_start_time: start,
                scheduled_end_time: end,
                transcription_provider_id: 'whisper',
                transcription_stream_config: {},
              },
            ])
            .execute();
          // Force rollback so we don't violate the constraint at commit.
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');

      const rows = await dbContext.db
        .selectFrom('sessions')
        .select('uid')
        .where('room_uid', '=', roomUid)
        .execute();
      expect(rows).toHaveLength(0);
    });
  });
});
