import { beforeEach, describe, expect } from 'vitest';

import { ScheduleManagementRepository } from '#src/server/features/schedule-management/schedule-management.repository.js';
import { ScheduleManagementService } from '#src/server/features/schedule-management/schedule-management.service.js';
import { EventBusService } from '#src/server/shared/services/event-bus.service.js';
import { createMockLogger } from '#tests/utils/mock-logger.js';
import { useDb } from '#tests/utils/use-db.js';

const NULL_UUID = '00000000-0000-0000-0000-000000000000';

describe('ScheduleManagementService', () => {
  const dbContext = useDb([
    'sessions',
    'session_schedules',
    'auto_session_windows',
    'rooms',
  ]);
  let repository: ScheduleManagementRepository;
  let service: ScheduleManagementService;

  beforeEach(() => {
    repository = new ScheduleManagementRepository(dbContext.dbClient);
    const logger = createMockLogger();
    service = new ScheduleManagementService(
      logger as never,
      dbContext.dbClient,
      repository,
      new EventBusService(logger as never),
    );
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

  async function getRoom(roomUid: string) {
    return dbContext.db
      .selectFrom('rooms')
      .select(['room_schedule_version', 'last_materialized_at', 'timezone'])
      .where('uid', '=', roomUid)
      .executeTakeFirstOrThrow();
  }

  async function listSessionsForRoom(roomUid: string) {
    return dbContext.db
      .selectFrom('sessions')
      .selectAll()
      .where('room_uid', '=', roomUid)
      .orderBy('scheduled_start_time', 'asc')
      .execute();
  }

  describe('createSchedule', (it) => {
    it('returns ROOM_NOT_FOUND when the room does not exist', async () => {
      // Arrange / Act
      const result = await service.createSchedule(
        {
          roomUid: NULL_UUID,
          name: 'X',
          activeStart: new Date('2024-06-01T00:00:00Z'),
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '10:00:00',
          frequency: 'ONCE',
          daysOfWeek: null,
          joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        new Date('2024-06-01T00:00:00Z'),
      );

      // Assert
      expect(result).toBe('ROOM_NOT_FOUND');
    });

    it('writes the schedule, materializes its sessions in the next 7 days, and bumps the room', async () => {
      // Arrange - a WEEKLY schedule firing on MON/WED/FRI at 14:00-15:00 UTC.
      const { uid: roomUid, room_schedule_version: versionBefore } =
        await insertRoom('UTC');
      // Pick `now` as a Sunday so the next Mon/Wed/Fri all fall within 7 days.
      const now = new Date('2024-06-02T12:00:00Z'); // Sun
      const activeStart = new Date(now.getTime() + 1);

      // Act
      const result = await service.createSchedule(
        {
          roomUid,
          name: 'Standup',
          activeStart,
          activeEnd: null,
          localStartTime: '14:00:00',
          localEndTime: '15:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON', 'WED', 'FRI'],
          joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert - schedule row exists; SCHEDULED sessions materialized for the
      // three weekdays; room version bumped; last_materialized_at set.
      expect(result).not.toBe('ROOM_NOT_FOUND');
      expect(result).not.toBe('CONFLICT');
      const schedule = result as Exclude<
        typeof result,
        | 'ROOM_NOT_FOUND'
        | 'CONFLICT'
        | 'INVALID_ACTIVE_START'
        | 'INVALID_ACTIVE_END'
        | 'INVALID_LOCAL_TIMES'
        | 'INVALID_FREQUENCY_FIELDS'
      >;
      const sessions = await listSessionsForRoom(roomUid);
      const scheduled = sessions.filter((s) => s.type === 'SCHEDULED');
      expect(scheduled).toHaveLength(3); // Mon, Wed, Fri within 7 days.
      for (const s of scheduled) {
        expect(s.scheduled_session_uid).toBe(schedule.uid);
      }
      const room = await getRoom(roomUid);
      expect(Number(room.room_schedule_version)).toBe(
        Number(versionBefore) + 1,
      );
      expect(room.last_materialized_at).toEqual(now);
    });

    it('honors a finite activeEnd: only materializes occurrences within [activeStart, activeEnd]', async () => {
      // Arrange - WEEKLY MON/WED/FRI, but activeEnd cuts off after Wed.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z'); // Sun
      const activeStart = new Date(now.getTime() + 1);
      const activeEnd = new Date('2024-06-06T00:00:00Z'); // Thu 00:00 UTC

      // Act
      const result = await service.createSchedule(
        {
          roomUid,
          name: 'Bounded',
          activeStart,
          activeEnd,
          localStartTime: '14:00:00',
          localEndTime: '15:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON', 'WED', 'FRI'],
          joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert - schedule row carries activeEnd; only Mon and Wed
      // occurrences materialize (Fri 06-07 is past activeEnd).
      expect(result).not.toBe('ROOM_NOT_FOUND');
      expect(result).not.toBe('CONFLICT');
      const schedule = result as Exclude<
        typeof result,
        | 'ROOM_NOT_FOUND'
        | 'CONFLICT'
        | 'INVALID_ACTIVE_START'
        | 'INVALID_ACTIVE_END'
        | 'INVALID_LOCAL_TIMES'
        | 'INVALID_FREQUENCY_FIELDS'
      >;
      expect(schedule.activeEnd).toEqual(activeEnd);
      const scheduled = (await listSessionsForRoom(roomUid)).filter(
        (s) => s.type === 'SCHEDULED',
      );
      expect(scheduled.map((s) => s.scheduled_start_time)).toEqual([
        new Date('2024-06-03T14:00:00Z'), // Mon
        new Date('2024-06-05T14:00:00Z'), // Wed
      ]);
    });

    it('returns INVALID_ACTIVE_END when activeEnd is at or before activeStart', async () => {
      // Arrange / Act
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z');
      const activeStart = new Date(now.getTime() + 1);
      const result = await service.createSchedule(
        {
          roomUid,
          name: 'Inverted',
          activeStart,
          activeEnd: activeStart, // caught by app-level check before DB
          localStartTime: '14:00:00',
          localEndTime: '15:00:00',
          frequency: 'ONCE',
          daysOfWeek: null,
          joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert
      expect(result).toBe('INVALID_ACTIVE_END');
    });

    it('returns CONFLICT and rolls back when the new schedule overlaps an existing one', async () => {
      // Arrange - an existing WEEKLY schedule on Mondays 14:00-15:00 UTC.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z'); // Sun
      const activeStart = new Date(now.getTime() + 1);
      const existing = await service.createSchedule(
        {
          roomUid,
          name: 'Existing',
          activeStart,
          activeEnd: null,
          localStartTime: '14:00:00',
          localEndTime: '15:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON'],
          joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      expect(existing).not.toBe('ROOM_NOT_FOUND');
      expect(existing).not.toBe('CONFLICT');
      const versionAfterFirst = (await getRoom(roomUid)).room_schedule_version;
      const sessionsAfterFirst = await listSessionsForRoom(roomUid);

      // Act - a second WEEKLY schedule on Mondays 14:30-15:30 - overlaps.
      const result = await service.createSchedule(
        {
          roomUid,
          name: 'Conflicting',
          activeStart,
          activeEnd: null,
          localStartTime: '14:30:00',
          localEndTime: '15:30:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON'],
          joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert - rejected; nothing changed.
      expect(result).toBe('CONFLICT');
      const sessionsAfter = await listSessionsForRoom(roomUid);
      expect(sessionsAfter.map((s) => s.uid).sort()).toEqual(
        sessionsAfterFirst.map((s) => s.uid).sort(),
      );
      const room = await getRoom(roomUid);
      expect(room.room_schedule_version).toEqual(versionAfterFirst);
    });
  });

  describe('findScheduleByUid', (it) => {
    it('returns NOT_FOUND for a missing uid', async () => {
      // Arrange / Act
      const result = await service.findScheduleByUid(NULL_UUID);

      // Assert
      expect(result).toBe('NOT_FOUND');
    });
  });

  describe('materializeOneStaleRoom', (it) => {
    async function setLastMaterializedAt(roomUid: string, value: Date | null) {
      await dbContext.db
        .updateTable('rooms')
        .set({ last_materialized_at: value })
        .where('uid', '=', roomUid)
        .execute();
    }

    it('returns null when no rooms are stale', async () => {
      // Arrange - one fresh room
      const { uid } = await insertRoom('UTC');
      await setLastMaterializedAt(uid, new Date());

      // Act
      const result = await service.materializeOneStaleRoom(
        new Date(),
        new Date(Date.now() - 60_000),
      );

      // Assert
      expect(result).toBeNull();
    });

    it('returns the processed room UID and stamps last_materialized_at + bumps version', async () => {
      // Arrange - room with NULL last_materialized_at; needs materialization
      const { uid: roomUid, room_schedule_version: versionBefore } =
        await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z');

      // Act
      const result = await service.materializeOneStaleRoom(now, now);

      // Assert
      expect(result).toBe(roomUid);
      const room = await getRoom(roomUid);
      expect(Number(room.room_schedule_version)).toBe(
        Number(versionBefore) + 1,
      );
      expect(room.last_materialized_at).toEqual(now);
    });

    it('extends SCHEDULED occurrences without duplicating existing ones', async () => {
      // Arrange - WEEKLY schedule created at T0; materialization horizon is
      // 7 days, so only the next 7 days get sessions. Then we advance "now"
      // by 7 days and re-materialize: the worker should add only the new
      // future occurrences, leaving the original ones intact.
      const { uid: roomUid } = await insertRoom('UTC');
      const t0 = new Date('2024-06-02T12:00:00Z'); // Sun
      // activeStart must be strictly > now per the create precondition.
      const activeStart = new Date(t0.getTime() + 1);
      await service.createSchedule(
        {
          roomUid,
          name: 'Daily',
          activeStart,
          activeEnd: null,
          localStartTime: '14:00:00',
          localEndTime: '15:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON', 'WED', 'FRI'],
          joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        t0,
      );
      const initialSessions = await listSessionsForRoom(roomUid);
      expect(
        initialSessions.filter((s) => s.type === 'SCHEDULED'),
      ).toHaveLength(3);
      // Capture the original session UIDs so we can confirm none are recreated.
      const originalUids = new Set(initialSessions.map((s) => s.uid));

      // Force the room to look stale.
      await setLastMaterializedAt(roomUid, new Date('2020-01-01T00:00:00Z'));

      // Act - advance "now" by 7 days; the next horizon should produce
      // additional Mon/Wed/Fri occurrences without recreating the originals.
      const t1 = new Date(t0.getTime() + 7 * 24 * 60 * 60 * 1000);
      const result = await service.materializeOneStaleRoom(
        t1,
        new Date(t1.getTime() - 1000),
      );

      // Assert
      expect(result).toBe(roomUid);
      const after = await listSessionsForRoom(roomUid);
      const scheduled = after.filter((s) => s.type === 'SCHEDULED');
      // Three more sessions added in the new 7-day window. Originals retained.
      expect(scheduled).toHaveLength(6);
      for (const orig of originalUids) {
        expect(scheduled.some((s) => s.uid === orig)).toBe(true);
      }
    });

    it('reconciles AUTO sessions when autoSessionEnabled and a window is active', async () => {
      // Arrange - room with auto sessions enabled and an open window covering
      // weekday afternoons. No prior materialization.
      const { uid: roomUid } = await insertRoom('UTC', true);
      const t0 = new Date('2024-06-02T12:00:00Z'); // Sun
      await service.createAutoSessionWindow(
        {
          roomUid,
          localStartTime: '13:00:00',
          localEndTime: '17:00:00',
          daysOfWeek: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
          activeStart: t0,
          activeEnd: null,
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        t0,
      );
      // Wipe any AUTO sessions that the create step materialized so we can
      // verify the worker re-creates them.
      await dbContext.db
        .deleteFrom('sessions')
        .where('room_uid', '=', roomUid)
        .where('type', '=', 'AUTO')
        .execute();
      await setLastMaterializedAt(roomUid, new Date('2020-01-01T00:00:00Z'));

      // Act
      const result = await service.materializeOneStaleRoom(t0, t0);

      // Assert - reconciler produced AUTO sessions for the weekday afternoons
      // within the 7-day window.
      expect(result).toBe(roomUid);
      const auto = (await listSessionsForRoom(roomUid)).filter(
        (s) => s.type === 'AUTO',
      );
      expect(auto.length).toBeGreaterThan(0);
    });

    it('respects excludeUids and picks a different room', async () => {
      // Arrange - two stale rooms
      const { uid: excludedUid } = await insertRoom('UTC');
      const { uid: pickedUid } = await insertRoom('UTC');

      // Act
      const result = await service.materializeOneStaleRoom(
        new Date(),
        new Date(),
        [excludedUid],
      );

      // Assert
      expect(result).toBe(pickedUid);
    });
  });

  describe('deleteSchedule', (it) => {
    it('hard-deletes a schedule whose activeStart is in the future', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-01T12:00:00Z');
      const future = new Date('2024-06-15T00:00:00Z');
      const schedule = (await service.createSchedule(
        {
          roomUid,
          name: 'Future',
          activeStart: future,
          activeEnd: null,
          localStartTime: '14:00:00',
          localEndTime: '15:00:00',
          frequency: 'ONCE',
          daysOfWeek: null,
          joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      )) as Exclude<
        Awaited<ReturnType<typeof service.createSchedule>>,
        | 'ROOM_NOT_FOUND'
        | 'CONFLICT'
        | 'INVALID_ACTIVE_START'
        | 'INVALID_ACTIVE_END'
        | 'INVALID_LOCAL_TIMES'
        | 'INVALID_FREQUENCY_FIELDS'
      >;

      // Act
      const result = await service.deleteSchedule(schedule.uid, now);

      // Assert - row gone.
      expect(result).toBeUndefined();
      const found = await repository.findScheduleByUid(
        repository.db,
        schedule.uid,
      );
      expect(found).toBeUndefined();
    });

    it('soft-deletes a schedule that has already produced sessions; preserves past, removes future', async () => {
      // Arrange - a WEEKLY MON schedule that started in the past. The
      // create-schedule precondition rejects `activeStart <= now`, so we seed
      // the past-active row directly via the repository to set up this scenario.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-05T12:00:00Z'); // Wed
      const pastStart = new Date('2024-05-01T00:00:00Z');
      const schedule = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'Recurring',
        activeStart: pastStart,
        activeEnd: null,
        anchorStart: pastStart,
        localStartTime: '14:00:00',
        localEndTime: '15:00:00',
        frequency: 'WEEKLY',
        daysOfWeek: ['MON'],
        joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      });
      // Insert a "past realized" session manually.
      await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Past',
          type: 'SCHEDULED',
          scheduled_session_uid: schedule.uid,
          scheduled_start_time: new Date('2024-05-06T14:00:00Z'),
          scheduled_end_time: new Date('2024-05-06T15:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .execute();

      // Act
      const result = await service.deleteSchedule(schedule.uid, now);

      // Assert
      expect(result).toBeUndefined();
      const found = await repository.findScheduleByUid(
        repository.db,
        schedule.uid,
      );
      expect(found?.activeEnd).not.toBeNull();
      // Past session still attached; future ones gone.
      const remaining = await dbContext.db
        .selectFrom('sessions')
        .select(['name', 'type', 'scheduled_start_time'])
        .where('scheduled_session_uid', '=', schedule.uid)
        .execute();
      const pastNames = remaining
        .filter((r) => r.scheduled_start_time < now)
        .map((r) => r.name);
      const futureNames = remaining
        .filter((r) => r.scheduled_start_time > now)
        .map((r) => r.name);
      expect(pastNames).toEqual(['Past']);
      expect(futureNames).toEqual([]);
    });

    it('returns NOT_FOUND for an already-closed or missing schedule', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom('UTC');
      // Insert a directly-closed schedule.
      const closed = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'Closed',
        activeStart: new Date('2024-01-01T00:00:00Z'),
        activeEnd: new Date('2024-03-01T00:00:00Z'),
        anchorStart: new Date('2024-01-01T00:00:00Z'),
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
        joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      });

      // Act
      const a = await service.deleteSchedule(closed.uid, new Date());
      const b = await service.deleteSchedule(NULL_UUID, new Date());

      // Assert
      expect(a).toBe('NOT_FOUND');
      expect(b).toBe('NOT_FOUND');
    });
  });

  describe('updateSchedule', (it) => {
    it('returns NOT_FOUND for a missing or closed schedule', async () => {
      // Arrange / Act
      const result = await service.updateSchedule(
        NULL_UUID,
        { name: 'X' },
        new Date(),
      );

      // Assert
      expect(result).toBe('NOT_FOUND');
    });

    it('produces a new uid; old uid is closed; new uid carries the upcoming sessions', async () => {
      // Arrange - the test verifies the past-active soft-close path. Since
      // create-schedule now requires activeStart > now, we seed the original
      // schedule directly via the repository so its activeStart is already
      // <= now at update time. The update supplies an explicit future
      // activeStart per the new precondition.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-05T12:00:00Z'); // Wed
      const pastStart = new Date('2024-05-27T00:00:00Z'); // a past Mon
      const original = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'Original',
        activeStart: pastStart,
        activeEnd: null,
        anchorStart: pastStart,
        localStartTime: '14:00:00',
        localEndTime: '15:00:00',
        frequency: 'WEEKLY',
        daysOfWeek: ['MON'],
        joinCodeScopes: ['RECEIVE_TRANSCRIPTIONS'],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      });

      // Act - rename the schedule and supply an explicit future activeStart
      // (required since the original schedule has already taken effect).
      const newActiveStart = new Date('2024-06-09T00:00:00Z'); // next Sun
      const result = await service.updateSchedule(
        original.uid,
        { name: 'Renamed', activeStart: newActiveStart },
        now,
      );

      // Assert
      expect(result).not.toBe('NOT_FOUND');
      expect(result).not.toBe('CONFLICT');
      expect(result).not.toBe('INVALID_ACTIVE_START');
      const updated = result as Exclude<
        typeof result,
        | 'NOT_FOUND'
        | 'CONFLICT'
        | 'INVALID_ACTIVE_START'
        | 'INVALID_ACTIVE_END'
        | 'INVALID_LOCAL_TIMES'
        | 'INVALID_FREQUENCY_FIELDS'
      >;
      expect(updated.uid).not.toBe(original.uid);
      expect(updated.name).toBe('Renamed');
      // Anchor preserved verbatim from the original - biweekly cadence is
      // invariant under updates even when activeStart shifts.
      expect(updated.anchorStart).toEqual(original.anchorStart);

      const oldRow = await repository.findScheduleByUid(
        repository.db,
        original.uid,
      );
      expect(oldRow?.activeEnd).not.toBeNull();

      // Future SCHEDULED sessions reference the new uid; the create path
      // re-materialized them under the merged row.
      const sessionsByUid = await dbContext.db
        .selectFrom('sessions')
        .select(['scheduled_session_uid'])
        .where('room_uid', '=', roomUid)
        .where('scheduled_start_time', '>', now)
        .execute();
      expect(
        sessionsByUid.every((s) => s.scheduled_session_uid === updated.uid),
      ).toBe(true);
    });
  });

  describe('createAutoSessionWindow', (it) => {
    it('returns ROOM_NOT_FOUND for a missing room', async () => {
      // Arrange / Act
      const now = new Date('2024-06-02T12:00:00Z'); // Sun
      const result = await service.createAutoSessionWindow(
        {
          roomUid: NULL_UUID,
          activeStart: now,
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '17:00:00',
          daysOfWeek: ['MON'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        new Date(),
      );

      // Assert
      expect(result).toBe('ROOM_NOT_FOUND');
    });

    it('inserts the window and reconciles auto sessions within the materialization window', async () => {
      // Arrange - a room with no schedules; the new window should produce
      // an auto session covering the upcoming MON 09:00-17:00 UTC slot.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z'); // Sun

      // Act
      const result = await service.createAutoSessionWindow(
        {
          roomUid,
          activeStart: now,
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '17:00:00',
          daysOfWeek: ['MON'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert
      expect(result).not.toBe('ROOM_NOT_FOUND');
      expect(result).not.toBe('CONFLICT');
      const sessions = await listSessionsForRoom(roomUid);
      const autos = sessions.filter((s) => s.type === 'AUTO');
      expect(autos).toHaveLength(1);
      expect(autos[0]!.scheduled_start_time).toEqual(
        new Date('2024-06-03T09:00:00Z'),
      );
      expect(autos[0]!.scheduled_end_time).toEqual(
        new Date('2024-06-03T17:00:00Z'),
      );
    });

    it('returns CONFLICT when two windows overlap on the same weekday', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z'); // Sun
      const first = await service.createAutoSessionWindow(
        {
          roomUid,
          activeStart: now,
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '12:00:00',
          daysOfWeek: ['MON'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      expect(first).not.toBe('ROOM_NOT_FOUND');
      expect(first).not.toBe('CONFLICT');

      // Act - a second MON window from 11:00-14:00 overlaps the first.
      const result = await service.createAutoSessionWindow(
        {
          roomUid,
          activeStart: now,
          activeEnd: null,
          localStartTime: '11:00:00',
          localEndTime: '14:00:00',
          daysOfWeek: ['MON'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert
      expect(result).toBe('CONFLICT');
    });
  });

  describe('deleteAutoSessionWindow', (it) => {
    it('removes the window and clears its auto sessions on next reconcile', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z'); // Sun
      const window = (await service.createAutoSessionWindow(
        {
          roomUid,
          activeStart: now,
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '17:00:00',
          daysOfWeek: ['MON'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      )) as Exclude<
        Awaited<ReturnType<typeof service.createAutoSessionWindow>>,
        | 'ROOM_NOT_FOUND'
        | 'CONFLICT'
        | 'INVALID_ACTIVE_START'
        | 'INVALID_ACTIVE_END'
        | 'INVALID_LOCAL_TIMES'
        | 'INVALID_FREQUENCY_FIELDS'
      >;
      // Sanity: there's an upcoming auto session.
      const before = await listSessionsForRoom(roomUid);
      expect(before.filter((s) => s.type === 'AUTO')).toHaveLength(1);

      // Act
      const result = await service.deleteAutoSessionWindow(window.uid, now);

      // Assert
      expect(result).toBeUndefined();
      const after = await listSessionsForRoom(roomUid);
      expect(after.filter((s) => s.type === 'AUTO')).toHaveLength(0);
    });
  });

  describe('listSessionsForRoomInRange', (it) => {
    it('returns sessions overlapping the range, ordered by effective start', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom('UTC');
      await dbContext.db
        .insertInto('sessions')
        .values([
          {
            room_uid: roomUid,
            name: 'In-range',
            type: 'ON_DEMAND',
            scheduled_start_time: new Date('2024-06-01T10:00:00Z'),
            scheduled_end_time: new Date('2024-06-01T11:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
          {
            room_uid: roomUid,
            name: 'Outside',
            type: 'ON_DEMAND',
            scheduled_start_time: new Date('2024-06-01T20:00:00Z'),
            scheduled_end_time: new Date('2024-06-01T21:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
        ])
        .execute();

      // Act
      const found = await service.listSessionsForRoomInRange(roomUid, {
        from: new Date('2024-06-01T09:00:00Z'),
        to: new Date('2024-06-01T13:00:00Z'),
      });

      // Assert
      expect(found.map((s) => s.name)).toEqual(['In-range']);
    });
  });

  describe('createSchedule - INVALID_ACTIVE_START precondition', (it) => {
    it('rejects when activeStart equals now', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z');

      // Act
      const result = await service.createSchedule(
        {
          roomUid,
          name: 'Bad',
          activeStart: now,
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '10:00:00',
          frequency: 'ONCE',
          daysOfWeek: null,
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert
      expect(result).toBe('INVALID_ACTIVE_START');
    });

    it('rejects when activeStart is 1 ms before now', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z');

      // Act
      const result = await service.createSchedule(
        {
          roomUid,
          name: 'Past',
          activeStart: new Date(now.getTime() - 1),
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '10:00:00',
          frequency: 'ONCE',
          daysOfWeek: null,
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert
      expect(result).toBe('INVALID_ACTIVE_START');
    });
  });

  describe('updateSchedule - INVALID_ACTIVE_START precondition', (it) => {
    it('rejects when the merged activeStart is in the past (no new activeStart supplied)', async () => {
      // Arrange - seed a past-active schedule so its activeStart is already
      // <= now. Updating without a new activeStart merges the existing
      // (past) value, which must be rejected.
      const { uid: roomUid } = await insertRoom('UTC');
      const pastStart = new Date('2024-05-01T00:00:00Z');
      const now = new Date('2024-06-05T12:00:00Z');
      const schedule = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'Past',
        activeStart: pastStart,
        activeEnd: null,
        anchorStart: pastStart,
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
        joinCodeScopes: [],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      });

      // Act - rename only; merged activeStart = pastStart <= now.
      const result = await service.updateSchedule(
        schedule.uid,
        { name: 'Renamed' },
        now,
      );

      // Assert
      expect(result).toBe('INVALID_ACTIVE_START');
    });

    it('rejects when an explicit past activeStart is supplied', async () => {
      // Arrange - a future-active schedule; update it with a past activeStart.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-05T12:00:00Z');
      const futureStart = new Date('2024-07-01T00:00:00Z');
      const schedule = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'Future',
        activeStart: futureStart,
        activeEnd: null,
        anchorStart: futureStart,
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
        joinCodeScopes: [],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      });

      // Act
      const result = await service.updateSchedule(
        schedule.uid,
        { activeStart: new Date('2024-01-01T00:00:00Z') },
        now,
      );

      // Assert
      expect(result).toBe('INVALID_ACTIVE_START');
    });
  });

  describe('updateSchedule - BIWEEKLY anchor preservation', (it) => {
    it('preserves anchorStart verbatim when activeStart is bumped forward', async () => {
      // Arrange - a BIWEEKLY schedule seeded with a specific anchorStart.
      const { uid: roomUid } = await insertRoom('UTC');
      const anchorDate = new Date('2024-05-06T00:00:00Z'); // Mon
      const now = new Date('2024-06-05T12:00:00Z');
      const original = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'Biweekly',
        activeStart: anchorDate,
        activeEnd: null,
        anchorStart: anchorDate,
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'BIWEEKLY',
        daysOfWeek: ['MON'],
        joinCodeScopes: [],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      });

      // Act - supply a new future activeStart; anchor must not shift.
      const newActiveStart = new Date('2024-06-10T00:00:00Z');
      const result = await service.updateSchedule(
        original.uid,
        { name: 'Updated', activeStart: newActiveStart },
        now,
      );

      // Assert
      expect(result).not.toBe('NOT_FOUND');
      expect(result).not.toBe('CONFLICT');
      expect(result).not.toBe('INVALID_ACTIVE_START');
      const updated = result as Exclude<
        typeof result,
        | 'NOT_FOUND'
        | 'CONFLICT'
        | 'INVALID_ACTIVE_START'
        | 'INVALID_ACTIVE_END'
        | 'INVALID_LOCAL_TIMES'
        | 'INVALID_FREQUENCY_FIELDS'
      >;
      // Anchor preserved verbatim; the updated activeStart is the new one.
      expect(updated.anchorStart).toEqual(anchorDate);
      expect(updated.activeStart).toEqual(newActiveStart);
    });
  });

  describe('createOnDemandSession', (it) => {
    it('returns ROOM_NOT_FOUND for a missing room', async () => {
      // Arrange / Act
      const result = await service.createOnDemandSession(
        {
          roomUid: NULL_UUID,
          name: 'Quick',
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        new Date(),
      );

      // Assert
      expect(result).toBe('ROOM_NOT_FOUND');
    });

    it('sets scheduledEnd to the next non-AUTO session start', async () => {
      // Arrange - a future non-AUTO session bounding the on-demand window.
      // Use ON_DEMAND to avoid the FK constraint on scheduled_session_uid.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-03T09:00:00Z');
      const nextStart = new Date('2024-06-03T14:00:00Z');
      await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Next Session',
          type: 'ON_DEMAND',
          scheduled_start_time: nextStart,
          scheduled_end_time: new Date('2024-06-03T15:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .execute();

      // Act
      const result = await service.createOnDemandSession(
        {
          roomUid,
          name: 'Meeting',
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert
      expect(result).not.toBe('ROOM_NOT_FOUND');
      expect(result).not.toBe('ANOTHER_SESSION_ACTIVE');
      const session = result as Exclude<
        typeof result,
        'ROOM_NOT_FOUND' | 'ANOTHER_SESSION_ACTIVE'
      >;
      expect(session.scheduledEndTime).toEqual(nextStart);
    });

    it('sets scheduledEnd to null when no upcoming non-AUTO session exists', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-03T09:00:00Z');

      // Act
      const result = await service.createOnDemandSession(
        {
          roomUid,
          name: 'Open-ended',
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert
      expect(result).not.toBe('ROOM_NOT_FOUND');
      expect(result).not.toBe('ANOTHER_SESSION_ACTIVE');
      const session = result as Exclude<
        typeof result,
        'ROOM_NOT_FOUND' | 'ANOTHER_SESSION_ACTIVE'
      >;
      expect(session.scheduledEndTime).toBeNull();
    });

    it('preempts an active AUTO session by setting end_override = now', async () => {
      // Arrange - an AUTO session currently running.
      const { uid: roomUid } = await insertRoom('UTC', true);
      const now = new Date('2024-06-03T10:00:00Z');
      const [autoRow] = await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Active Auto',
          type: 'AUTO',
          scheduled_start_time: new Date('2024-06-03T09:00:00Z'),
          scheduled_end_time: new Date('2024-06-03T17:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .returning('uid')
        .execute();

      // Act
      const result = await service.createOnDemandSession(
        {
          roomUid,
          name: 'Meeting',
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert - on-demand created; AUTO ended at now.
      expect(result).not.toBe('ROOM_NOT_FOUND');
      expect(result).not.toBe('ANOTHER_SESSION_ACTIVE');
      const preempted = await dbContext.db
        .selectFrom('sessions')
        .select('end_override')
        .where('uid', '=', autoRow!.uid)
        .executeTakeFirstOrThrow();
      expect(preempted.end_override).toEqual(now);
    });

    it('returns ANOTHER_SESSION_ACTIVE when a non-AUTO session is currently active', async () => {
      // Arrange - ON_DEMAND session active now (avoids scheduled_session_uid FK).
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-03T10:00:00Z');
      await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Active Session',
          type: 'ON_DEMAND',
          scheduled_start_time: new Date('2024-06-03T09:00:00Z'),
          scheduled_end_time: new Date('2024-06-03T11:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .execute();

      // Act
      const result = await service.createOnDemandSession(
        {
          roomUid,
          name: 'Blocked',
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert
      expect(result).toBe('ANOTHER_SESSION_ACTIVE');
    });
  });

  describe('startSessionEarly', (it) => {
    it('sets start_override = now and returns the updated session', async () => {
      // Arrange - a single upcoming ON_DEMAND session (the only one in the room).
      // ON_DEMAND avoids the scheduled_session_uid FK; startSessionEarly only
      // rejects AUTO sessions - ON_DEMAND is a valid target.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-03T08:00:00Z');
      const [row] = await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Morning',
          type: 'ON_DEMAND',
          scheduled_start_time: new Date('2024-06-03T09:00:00Z'),
          scheduled_end_time: new Date('2024-06-03T10:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .returning('uid')
        .execute();

      // Act
      const result = await service.startSessionEarly(row!.uid, now);

      // Assert
      expect(result).not.toBe('NOT_FOUND');
      expect(result).not.toBe('NOT_NEXT_UPCOMING');
      expect(result).not.toBe('ANOTHER_SESSION_ACTIVE');
      expect(result).not.toBe('SESSION_IS_AUTO');
      const updated = result as Exclude<
        typeof result,
        | 'NOT_FOUND'
        | 'NOT_NEXT_UPCOMING'
        | 'ANOTHER_SESSION_ACTIVE'
        | 'SESSION_IS_AUTO'
      >;
      expect(updated.startOverride).toEqual(now);
    });

    it('preempts an active AUTO session when starting early', async () => {
      // Arrange - an AUTO session currently running; an upcoming ON_DEMAND one.
      const { uid: roomUid } = await insertRoom('UTC', true);
      const now = new Date('2024-06-03T08:30:00Z');
      const [autoRow] = await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Active Auto',
          type: 'AUTO',
          scheduled_start_time: new Date('2024-06-03T08:00:00Z'),
          scheduled_end_time: new Date('2024-06-03T09:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .returning('uid')
        .execute();
      const [upcomingRow] = await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Upcoming',
          type: 'ON_DEMAND',
          scheduled_start_time: new Date('2024-06-03T09:00:00Z'),
          scheduled_end_time: new Date('2024-06-03T10:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .returning('uid')
        .execute();

      // Act
      const result = await service.startSessionEarly(upcomingRow!.uid, now);

      // Assert - upcoming session started early; AUTO ended via end_override.
      expect(result).not.toBe('NOT_FOUND');
      expect(result).not.toBe('NOT_NEXT_UPCOMING');
      expect(result).not.toBe('ANOTHER_SESSION_ACTIVE');
      expect(result).not.toBe('SESSION_IS_AUTO');
      const autoRowAfter = await dbContext.db
        .selectFrom('sessions')
        .select('end_override')
        .where('uid', '=', autoRow!.uid)
        .executeTakeFirstOrThrow();
      expect(autoRowAfter.end_override).toEqual(now);
    });

    it('returns NOT_NEXT_UPCOMING when the target is not the next upcoming session', async () => {
      // Arrange - two upcoming ON_DEMAND sessions; try to start the later one.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-03T08:00:00Z');
      await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Earlier',
          type: 'ON_DEMAND',
          scheduled_start_time: new Date('2024-06-03T09:00:00Z'),
          scheduled_end_time: new Date('2024-06-03T10:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .execute();
      const [laterRow] = await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Later',
          type: 'ON_DEMAND',
          scheduled_start_time: new Date('2024-06-03T11:00:00Z'),
          scheduled_end_time: new Date('2024-06-03T12:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .returning('uid')
        .execute();

      // Act - target the later session; the earlier one is the real next.
      const result = await service.startSessionEarly(laterRow!.uid, now);

      // Assert
      expect(result).toBe('NOT_NEXT_UPCOMING');
    });

    it('returns SESSION_IS_AUTO for an AUTO session', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom('UTC', true);
      const now = new Date('2024-06-03T08:00:00Z');
      const [autoRow] = await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Auto',
          type: 'AUTO',
          scheduled_start_time: new Date('2024-06-03T09:00:00Z'),
          scheduled_end_time: new Date('2024-06-03T10:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .returning('uid')
        .execute();

      // Act
      const result = await service.startSessionEarly(autoRow!.uid, now);

      // Assert
      expect(result).toBe('SESSION_IS_AUTO');
    });
  });

  describe('endSessionEarly', (it) => {
    it('sets end_override = now and returns the updated session', async () => {
      // Arrange - an ON_DEMAND session currently active.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-03T10:00:00Z');
      const [row] = await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Active OD',
          type: 'ON_DEMAND',
          scheduled_start_time: new Date('2024-06-03T09:00:00Z'),
          scheduled_end_time: new Date('2024-06-03T17:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .returning('uid')
        .execute();

      // Act
      const result = await service.endSessionEarly(row!.uid, now);

      // Assert
      expect(result).not.toBe('NOT_FOUND');
      expect(result).not.toBe('SESSION_NOT_ACTIVE');
      expect(result).not.toBe('SESSION_IS_AUTO');
      const updated = result as Exclude<
        typeof result,
        'NOT_FOUND' | 'SESSION_NOT_ACTIVE' | 'SESSION_IS_AUTO'
      >;
      expect(updated.endOverride).toEqual(now);
    });

    it('reconciles AUTO sessions into the freed gap after ending early', async () => {
      // Arrange - an active ON_DEMAND session blocking AUTO reconciliation,
      // with an auto window covering the rest of the day.
      const { uid: roomUid } = await insertRoom('UTC', true);
      const windowNow = new Date('2024-06-02T12:00:00Z'); // Sun
      await service.createAutoSessionWindow(
        {
          roomUid,
          localStartTime: '09:00:00',
          localEndTime: '17:00:00',
          daysOfWeek: ['MON'],
          activeStart: windowNow,
          activeEnd: null,
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        windowNow,
      );
      // Clear any AUTO sessions created by the window so we start clean.
      await dbContext.db
        .deleteFrom('sessions')
        .where('room_uid', '=', roomUid)
        .where('type', '=', 'AUTO')
        .execute();

      // Insert an open-ended ON_DEMAND session (blocks AUTO reconciliation).
      const now = new Date('2024-06-03T09:00:00Z');
      const [odRow] = await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'On-demand',
          type: 'ON_DEMAND',
          scheduled_start_time: now,
          scheduled_end_time: null,
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .returning('uid')
        .execute();

      const endAt = new Date('2024-06-03T10:00:00Z');

      // Act - end the on-demand session; reconciler fills [10:00, 17:00].
      await service.endSessionEarly(odRow!.uid, endAt);

      // Assert - an AUTO session starting at endAt is produced.
      const autos = await dbContext.db
        .selectFrom('sessions')
        .select(['scheduled_start_time', 'scheduled_end_time', 'type'])
        .where('room_uid', '=', roomUid)
        .where('type', '=', 'AUTO')
        .execute();
      expect(
        autos.some((s) => s.scheduled_start_time.getTime() === endAt.getTime()),
      ).toBe(true);
    });

    it('returns SESSION_NOT_ACTIVE for a future session', async () => {
      // Arrange - ON_DEMAND with a future start; avoids scheduled_session_uid FK.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-03T08:00:00Z');
      const [row] = await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Future',
          type: 'ON_DEMAND',
          scheduled_start_time: new Date('2024-06-03T09:00:00Z'),
          scheduled_end_time: new Date('2024-06-03T10:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .returning('uid')
        .execute();

      // Act
      const result = await service.endSessionEarly(row!.uid, now);

      // Assert
      expect(result).toBe('SESSION_NOT_ACTIVE');
    });

    it('returns SESSION_IS_AUTO for an AUTO session', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom('UTC', true);
      const now = new Date('2024-06-03T10:00:00Z');
      const [row] = await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Active Auto',
          type: 'AUTO',
          scheduled_start_time: new Date('2024-06-03T09:00:00Z'),
          scheduled_end_time: new Date('2024-06-03T11:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .returning('uid')
        .execute();

      // Act
      const result = await service.endSessionEarly(row!.uid, now);

      // Assert
      expect(result).toBe('SESSION_IS_AUTO');
    });
  });

  describe('updateRoomScheduleConfig', (it) => {
    it('returns ROOM_NOT_FOUND for a missing room', async () => {
      // Arrange / Act
      const result = await service.updateRoomScheduleConfig(
        NULL_UUID,
        { autoSessionEnabled: true },
        new Date(),
      );

      // Assert
      expect(result).toBe('ROOM_NOT_FOUND');
    });

    it('materializes AUTO sessions when autoSessionEnabled is flipped to true', async () => {
      // Arrange - room starts disabled; window exists but no AUTO sessions.
      const { uid: roomUid } = await insertRoom('UTC', false);
      const now = new Date('2024-06-02T12:00:00Z'); // Sun
      await service.createAutoSessionWindow(
        {
          roomUid,
          localStartTime: '09:00:00',
          localEndTime: '17:00:00',
          daysOfWeek: ['MON'],
          activeStart: now,
          activeEnd: null,
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      // createAutoSessionWindow reconciles with autoSessionEnabled=false → 0 AUTO sessions.
      const autoBefore = (await listSessionsForRoom(roomUid)).filter(
        (s) => s.type === 'AUTO',
      );
      expect(autoBefore).toHaveLength(0);

      // Act
      const result = await service.updateRoomScheduleConfig(
        roomUid,
        { autoSessionEnabled: true },
        now,
      );

      // Assert - reconciler produced AUTO sessions for the upcoming MON window.
      expect(result).toBeUndefined();
      const autoAfter = (await listSessionsForRoom(roomUid)).filter(
        (s) => s.type === 'AUTO',
      );
      expect(autoAfter.length).toBeGreaterThan(0);
    });

    it('drops future AUTO sessions when autoSessionEnabled is flipped to false', async () => {
      // Arrange - room with auto enabled; window produces upcoming AUTO sessions.
      const { uid: roomUid } = await insertRoom('UTC', true);
      const now = new Date('2024-06-02T12:00:00Z'); // Sun
      await service.createAutoSessionWindow(
        {
          roomUid,
          localStartTime: '09:00:00',
          localEndTime: '17:00:00',
          daysOfWeek: ['MON', 'WED', 'FRI'],
          activeStart: now,
          activeEnd: null,
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      const autoBefore = (await listSessionsForRoom(roomUid)).filter(
        (s) => s.type === 'AUTO',
      );
      expect(autoBefore.length).toBeGreaterThan(0);

      // Act
      await service.updateRoomScheduleConfig(
        roomUid,
        { autoSessionEnabled: false },
        now,
      );

      // Assert - all future AUTO sessions removed.
      const futureAuto = (await listSessionsForRoom(roomUid)).filter(
        (s) => s.type === 'AUTO' && s.scheduled_start_time > now,
      );
      expect(futureAuto).toHaveLength(0);
    });

    it('ends an active AUTO session via end_override when disabled', async () => {
      // Arrange - an AUTO session currently in progress.
      const { uid: roomUid } = await insertRoom('UTC', true);
      const now = new Date('2024-06-03T10:00:00Z');
      const [autoRow] = await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Active Auto',
          type: 'AUTO',
          scheduled_start_time: new Date('2024-06-03T09:00:00Z'),
          scheduled_end_time: new Date('2024-06-03T17:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .returning('uid')
        .execute();

      // Act
      await service.updateRoomScheduleConfig(
        roomUid,
        { autoSessionEnabled: false },
        now,
      );

      // Assert
      const auto = await dbContext.db
        .selectFrom('sessions')
        .select('end_override')
        .where('uid', '=', autoRow!.uid)
        .executeTakeFirstOrThrow();
      expect(auto.end_override).toEqual(now);
    });

    it('is a no-op and does not bump room_schedule_version when value is unchanged', async () => {
      // Arrange - room with auto enabled.
      const { uid: roomUid, room_schedule_version: versionBefore } =
        await insertRoom('UTC', true);
      const now = new Date('2024-06-02T12:00:00Z');

      // Act - supply the same value that already exists.
      await service.updateRoomScheduleConfig(
        roomUid,
        { autoSessionEnabled: true },
        now,
      );

      // Assert - no version bump because nothing changed.
      const room = await getRoom(roomUid);
      expect(Number(room.room_schedule_version)).toBe(Number(versionBefore));
    });
  });

  describe('deleteAutoSessionWindow - active AUTO session handling', (it) => {
    it('sets end_override on the active AUTO session when its window is deleted', async () => {
      // Arrange - create a window and then manually insert an active AUTO session.
      const { uid: roomUid } = await insertRoom('UTC', true);
      const t0 = new Date('2024-06-02T12:00:00Z'); // Sun
      const windowResult = await service.createAutoSessionWindow(
        {
          roomUid,
          localStartTime: '09:00:00',
          localEndTime: '17:00:00',
          daysOfWeek: ['MON'],
          activeStart: t0,
          activeEnd: null,
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        t0,
      );
      const window = windowResult as Exclude<
        typeof windowResult,
        | 'ROOM_NOT_FOUND'
        | 'CONFLICT'
        | 'INVALID_ACTIVE_START'
        | 'INVALID_ACTIVE_END'
        | 'INVALID_LOCAL_TIMES'
        | 'INVALID_FREQUENCY_FIELDS'
      >;

      // Clear existing AUTO sessions and insert one that is currently running.
      await dbContext.db
        .deleteFrom('sessions')
        .where('room_uid', '=', roomUid)
        .where('type', '=', 'AUTO')
        .execute();
      const now = new Date('2024-06-03T10:00:00Z'); // Mon 10:00
      const [autoRow] = await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Active Auto',
          type: 'AUTO',
          scheduled_start_time: new Date('2024-06-03T09:00:00Z'),
          scheduled_end_time: new Date('2024-06-03T17:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .returning('uid')
        .execute();

      // Act - delete the window while the AUTO session is active.
      const result = await service.deleteAutoSessionWindow(window.uid, now);

      // Assert - active AUTO session ended at now via end_override.
      expect(result).toBeUndefined();
      const auto = await dbContext.db
        .selectFrom('sessions')
        .select('end_override')
        .where('uid', '=', autoRow!.uid)
        .executeTakeFirstOrThrow();
      expect(auto.end_override).toEqual(now);
    });
  });

  describe('materializeOneStaleRoom - additional edge cases', (it) => {
    async function setLastMaterializedAt(roomUid: string, value: Date | null) {
      await dbContext.db
        .updateTable('rooms')
        .set({ last_materialized_at: value })
        .where('uid', '=', roomUid)
        .execute();
    }

    it('reconciliation is idempotent: re-running at the same instant does not duplicate sessions', async () => {
      // Arrange - a room with a WEEKLY schedule already materialized.
      const { uid: roomUid } = await insertRoom('UTC', false);
      const now = new Date('2024-06-02T12:00:00Z'); // Sun
      const activeStart = new Date(now.getTime() + 1);
      await service.createSchedule(
        {
          roomUid,
          name: 'Idempotent',
          activeStart,
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '10:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON', 'WED', 'FRI'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      const afterCreate = (await listSessionsForRoom(roomUid)).filter(
        (s) => s.type === 'SCHEDULED',
      );

      // Force stale and re-materialize at the same instant.
      await setLastMaterializedAt(roomUid, new Date('2020-01-01T00:00:00Z'));
      await service.materializeOneStaleRoom(now, new Date(now.getTime() - 1));

      // Assert - session count unchanged (no duplicates added).
      const afterRe = (await listSessionsForRoom(roomUid)).filter(
        (s) => s.type === 'SCHEDULED',
      );
      expect(afterRe).toHaveLength(afterCreate.length);
    });

    it('claims distinct rooms when called concurrently (FOR UPDATE SKIP LOCKED)', async () => {
      // Arrange - three rooms all stale and eligible for materialization.
      const rooms = await Promise.all([
        insertRoom('UTC', false),
        insertRoom('UTC', false),
        insertRoom('UTC', false),
      ]);
      const cutoff = new Date('2024-06-02T11:00:00Z');
      const now = new Date('2024-06-02T12:00:00Z');
      for (const r of rooms) {
        await setLastMaterializedAt(r.uid, new Date('2020-01-01T00:00:00Z'));
      }

      // Act - kick off two concurrent worker calls. Each opens its own
      // transaction; SKIP LOCKED must hand them different rows.
      const [first, second] = await Promise.all([
        service.materializeOneStaleRoom(now, cutoff),
        service.materializeOneStaleRoom(now, cutoff),
      ]);

      // Assert - both workers got a non-null UID and the UIDs are distinct.
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first).not.toBe(second);
      expect(rooms.map((r) => r.uid)).toContain(first);
      expect(rooms.map((r) => r.uid)).toContain(second);

      // The third room should still be claimable on a follow-up call.
      const third = await service.materializeOneStaleRoom(now, cutoff);
      expect(third).not.toBeNull();
      expect([first, second]).not.toContain(third);
    });

    it('returns null on the second concurrent call when only one stale room exists', async () => {
      // Arrange - exactly one stale room.
      const { uid } = await insertRoom('UTC', false);
      const cutoff = new Date('2024-06-02T11:00:00Z');
      const now = new Date('2024-06-02T12:00:00Z');
      await setLastMaterializedAt(uid, new Date('2020-01-01T00:00:00Z'));

      // Act - two concurrent workers compete; one should get the room,
      // the other should get null (SKIP LOCKED, no other row to claim).
      const [first, second] = await Promise.all([
        service.materializeOneStaleRoom(now, cutoff),
        service.materializeOneStaleRoom(now, cutoff),
      ]);

      // Assert - exactly one winner.
      const results = [first, second].sort();
      expect(results).toEqual([null, uid].sort());
    });

    it('does not fill gaps shorter than 60 s (MIN_AUTO_SESSION_DURATION_SECONDS)', async () => {
      // Arrange - a window from 09:00:00 to 09:01:01 on MON with a SCHEDULED
      // session from 09:00:01 to 09:01:00 leaving a 1 s pre-gap and 1 s
      // post-gap - both below the 60 s threshold.
      const { uid: roomUid } = await insertRoom('UTC', true);
      const now = new Date('2024-06-02T12:00:00Z'); // Sun

      await service.createAutoSessionWindow(
        {
          roomUid,
          localStartTime: '09:00:00',
          localEndTime: '09:01:01',
          daysOfWeek: ['MON'],
          activeStart: now,
          activeEnd: null,
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      // Clear AUTO sessions from the window creation BEFORE inserting the
      // ON_DEMAND session (the AUTO session would otherwise overlap it).
      await dbContext.db
        .deleteFrom('sessions')
        .where('room_uid', '=', roomUid)
        .where('type', '=', 'AUTO')
        .execute();
      // Insert an ON_DEMAND session filling most of the tiny window
      // (avoids the scheduled_session_uid FK on SCHEDULED type).
      await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Tiny Session',
          type: 'ON_DEMAND',
          scheduled_start_time: new Date('2024-06-03T09:00:01Z'),
          scheduled_end_time: new Date('2024-06-03T09:01:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .execute();

      // Force re-materialization so the reconciler picks up the ON_DEMAND session.
      await setLastMaterializedAt(roomUid, new Date('2020-01-01T00:00:00Z'));
      await service.materializeOneStaleRoom(now, new Date(now.getTime() - 1));

      // Assert - both sub-60 s gaps are ignored; no AUTO sessions produced.
      const autos = (await listSessionsForRoom(roomUid)).filter(
        (s) => s.type === 'AUTO',
      );
      expect(autos).toHaveLength(0);
    });
  });

  describe('listActiveAndUpcomingSessions', (it) => {
    it('splits the at-most-one active session from the upcoming list', async () => {
      // Arrange
      const now = new Date('2024-06-01T12:00:00Z');
      const upTo = new Date('2024-06-01T18:00:00Z');
      const { uid: roomUid } = await insertRoom('UTC');
      await dbContext.db
        .insertInto('sessions')
        .values([
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
            name: 'Upcoming',
            type: 'ON_DEMAND',
            scheduled_start_time: new Date('2024-06-01T14:00:00Z'),
            scheduled_end_time: new Date('2024-06-01T15:00:00Z'),
            transcription_provider_id: 'whisper',
            transcription_stream_config: {},
          },
        ])
        .execute();

      // Act
      const { active, upcoming } = await service.listActiveAndUpcomingSessions(
        roomUid,
        now,
        upTo,
      );

      // Assert
      expect(active?.name).toBe('Active');
      expect(upcoming.map((s) => s.name)).toEqual(['Upcoming']);
    });

    it('returns active = null when nothing is currently running', async () => {
      // Arrange
      const now = new Date('2024-06-01T12:00:00Z');
      const upTo = new Date('2024-06-01T18:00:00Z');
      const { uid: roomUid } = await insertRoom('UTC');
      await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Upcoming',
          type: 'ON_DEMAND',
          scheduled_start_time: new Date('2024-06-01T14:00:00Z'),
          scheduled_end_time: new Date('2024-06-01T15:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .execute();

      // Act
      const { active, upcoming } = await service.listActiveAndUpcomingSessions(
        roomUid,
        now,
        upTo,
      );

      // Assert
      expect(active).toBeNull();
      expect(upcoming.map((s) => s.name)).toEqual(['Upcoming']);
    });
  });

  describe('createSchedule - INVALID_LOCAL_TIMES and INVALID_FREQUENCY_FIELDS', (it) => {
    it('returns INVALID_LOCAL_TIMES when localStartTime equals localEndTime', async () => {
      // Arrange / Act
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z');
      const result = await service.createSchedule(
        {
          roomUid,
          name: 'Same times',
          activeStart: new Date(now.getTime() + 1),
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '09:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert
      expect(result).toBe('INVALID_LOCAL_TIMES');
    });

    it('returns INVALID_FREQUENCY_FIELDS for WEEKLY with null daysOfWeek', async () => {
      // Arrange / Act
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z');
      const result = await service.createSchedule(
        {
          roomUid,
          name: 'WEEKLY no days',
          activeStart: new Date(now.getTime() + 1),
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '10:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: null,
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert
      expect(result).toBe('INVALID_FREQUENCY_FIELDS');
    });

    it('returns INVALID_FREQUENCY_FIELDS for WEEKLY with empty daysOfWeek array', async () => {
      // Arrange
      // An empty array slips past the DB CHECK constraint because
      // array_length('{}', 1) returns NULL in PostgreSQL, and NULL in a CHECK
      // evaluates to unknown (not false), so the constraint passes. The
      // application-level guard must catch this before reaching the DB.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z');

      // Act
      const result = await service.createSchedule(
        {
          roomUid,
          name: 'WEEKLY empty days',
          activeStart: new Date(now.getTime() + 1),
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '10:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: [],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert
      expect(result).toBe('INVALID_FREQUENCY_FIELDS');
    });

    it('returns INVALID_FREQUENCY_FIELDS for ONCE with non-null daysOfWeek', async () => {
      // Arrange / Act
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z');
      const result = await service.createSchedule(
        {
          roomUid,
          name: 'ONCE with days',
          activeStart: new Date(now.getTime() + 1),
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '10:00:00',
          frequency: 'ONCE',
          daysOfWeek: ['MON'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert
      expect(result).toBe('INVALID_FREQUENCY_FIELDS');
    });
  });

  describe('updateSchedule - INVALID_ACTIVE_END, INVALID_LOCAL_TIMES, INVALID_FREQUENCY_FIELDS', (it) => {
    async function seedFutureSchedule(
      roomUid: string,
      now: Date,
      overrides: Partial<Parameters<typeof service.createSchedule>[0]> = {},
    ) {
      return service.createSchedule(
        {
          roomUid,
          name: 'Base',
          activeStart: new Date(now.getTime() + 1),
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '10:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
          ...overrides,
        },
        now,
      ) as Promise<
        Exclude<
          Awaited<ReturnType<typeof service.createSchedule>>,
          | 'ROOM_NOT_FOUND'
          | 'CONFLICT'
          | 'INVALID_ACTIVE_START'
          | 'INVALID_ACTIVE_END'
          | 'INVALID_LOCAL_TIMES'
          | 'INVALID_FREQUENCY_FIELDS'
        >
      >;
    }

    it('returns INVALID_ACTIVE_END when the merged activeEnd would be at or before activeStart', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z');
      const activeStart = new Date(now.getTime() + 1);
      const schedule = await seedFutureSchedule(roomUid, now);

      // Act - set activeEnd equal to the existing activeStart (zero-length range)
      const result = await service.updateSchedule(
        schedule.uid,
        { activeEnd: activeStart },
        now,
      );

      // Assert
      expect(result).toBe('INVALID_ACTIVE_END');
    });

    it('returns INVALID_LOCAL_TIMES when the merged times are equal', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z');
      const schedule = await seedFutureSchedule(roomUid, now);

      // Act - update end time to match start time
      const result = await service.updateSchedule(
        schedule.uid,
        { localEndTime: '09:00:00' },
        now,
      );

      // Assert
      expect(result).toBe('INVALID_LOCAL_TIMES');
    });

    it('returns INVALID_FREQUENCY_FIELDS when changing frequency to BIWEEKLY with empty daysOfWeek', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z');
      const schedule = await seedFutureSchedule(roomUid, now);

      // Act
      const result = await service.updateSchedule(
        schedule.uid,
        { frequency: 'BIWEEKLY', daysOfWeek: [] },
        now,
      );

      // Assert
      expect(result).toBe('INVALID_FREQUENCY_FIELDS');
    });

    it('returns CONFLICT when the updated schedule overlaps an existing schedule', async () => {
      // Arrange - two schedules that would overlap if A is shifted.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z'); // Sun
      const activeStart = new Date(now.getTime() + 1);

      // Schedule A: MON 09:00-10:00, will be updated.
      const schedA = await seedFutureSchedule(roomUid, now);
      // Schedule B: MON 09:30-10:30 (conflicts with A if A stays at 09:00-10:00)
      // We must create B on a different day to avoid the initial conflict.
      // Use WED here; then update A to WED 09:30-10:30 so it overlaps B.
      await service.createSchedule(
        {
          roomUid,
          name: 'Blocker',
          activeStart,
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '10:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['WED'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      const versionBefore = (await getRoom(roomUid)).room_schedule_version;
      const sessionsBefore = await listSessionsForRoom(roomUid);

      // Act - update A to WED 09:30-10:30 - overlaps Blocker (WED 09:00-10:00)
      const result = await service.updateSchedule(
        schedA.uid,
        {
          daysOfWeek: ['WED'],
          localStartTime: '09:30:00',
          localEndTime: '10:30:00',
        },
        now,
      );

      // Assert - CONFLICT; state unchanged.
      expect(result).toBe('CONFLICT');
      const sessionsAfter = await listSessionsForRoom(roomUid);
      expect(sessionsAfter.map((s) => s.uid).sort()).toEqual(
        sessionsBefore.map((s) => s.uid).sort(),
      );
      const room = await getRoom(roomUid);
      expect(room.room_schedule_version).toEqual(versionBefore);
    });
  });

  describe('conflict detection - cross-frequency and boundary cases', (it) => {
    it('detects CONFLICT between ONCE and WEEKLY when they fire at the same time', async () => {
      // Arrange - a WEEKLY MON 09:00-10:00 UTC schedule.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z'); // Sun
      const activeStart = new Date(now.getTime() + 1);
      await service.createSchedule(
        {
          roomUid,
          name: 'Weekly',
          activeStart,
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '10:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Act - ONCE schedule whose activeStart puts it on Mon Jun 3 in UTC.
      // activeStart = Jun 3 00:00:01 → startOf('day') = Jun 3 → session at 09:30-10:30,
      // which overlaps the existing WEEKLY MON 09:00-10:00.
      const result = await service.createSchedule(
        {
          roomUid,
          name: 'Once',
          activeStart: new Date('2024-06-03T00:00:01Z'),
          activeEnd: null,
          localStartTime: '09:30:00',
          localEndTime: '10:30:00',
          frequency: 'ONCE',
          daysOfWeek: null,
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert
      expect(result).toBe('CONFLICT');
    });

    it('does not detect conflict between two BIWEEKLY schedules on strictly alternating weeks', async () => {
      // Arrange
      // Schedule A fires on even weeks relative to anchor May 27 (Jun 10, Jun 24, ...).
      // Schedule B fires on even weeks relative to anchor Jun 3 (Jun 3 is filtered by
      // activeStart, so effectively Jun 17, Jul 1, ...). No overlap within 14-day window.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z'); // Sun

      await service.createSchedule(
        {
          roomUid,
          name: 'Biweekly A',
          activeStart: new Date(now.getTime() + 1),
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '10:00:00',
          frequency: 'BIWEEKLY',
          daysOfWeek: ['MON'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Act - schedule B with activeStart on the following Sunday so that its
      // anchor week (Jun 3) is offset by exactly one week from A's anchor (May 27).
      const result = await service.createSchedule(
        {
          roomUid,
          name: 'Biweekly B',
          activeStart: new Date('2024-06-09T00:00:01Z'), // Sun Jun 9 → anchor week Jun 3
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '10:00:00',
          frequency: 'BIWEEKLY',
          daysOfWeek: ['MON'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert - succeeds because the two BIWEEKLY cadences never overlap.
      expect(result).not.toBe('ROOM_NOT_FOUND');
      expect(result).not.toBe('CONFLICT');
      expect(result).not.toBe('INVALID_ACTIVE_START');
      const schedule = result as Exclude<
        typeof result,
        | 'ROOM_NOT_FOUND'
        | 'CONFLICT'
        | 'INVALID_ACTIVE_START'
        | 'INVALID_ACTIVE_END'
        | 'INVALID_LOCAL_TIMES'
        | 'INVALID_FREQUENCY_FIELDS'
      >;
      expect(schedule.name).toBe('Biweekly B');
    });

    it('does not detect conflict when the end of one schedule exactly equals the start of the next', async () => {
      // Arrange - WEEKLY MON 09:00-10:00 UTC.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z'); // Sun
      const activeStart = new Date(now.getTime() + 1);
      await service.createSchedule(
        {
          roomUid,
          name: 'First',
          activeStart,
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '10:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Act - WEEKLY MON 10:00-11:00 UTC: starts exactly when First ends.
      // The overlap test is a.startUtc < b.endUtc && b.startUtc < a.endUtc;
      // b.startUtc (10:00) < a.endUtc (10:00) is false → no conflict.
      const result = await service.createSchedule(
        {
          roomUid,
          name: 'Adjacent',
          activeStart,
          activeEnd: null,
          localStartTime: '10:00:00',
          localEndTime: '11:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert
      expect(result).not.toBe('ROOM_NOT_FOUND');
      expect(result).not.toBe('CONFLICT');
      const schedule = result as Exclude<
        typeof result,
        | 'ROOM_NOT_FOUND'
        | 'CONFLICT'
        | 'INVALID_ACTIVE_START'
        | 'INVALID_ACTIVE_END'
        | 'INVALID_LOCAL_TIMES'
        | 'INVALID_FREQUENCY_FIELDS'
      >;
      expect(schedule.name).toBe('Adjacent');
    });
  });

  describe('auto reconciliation - createSchedule and deleteSchedule', (it) => {
    it('splits AUTO sessions around a new WEEKLY schedule that falls inside the auto window', async () => {
      // Arrange - room with an auto window covering MON 09:00-17:00 UTC.
      const { uid: roomUid } = await insertRoom('UTC', true);
      const now = new Date('2024-06-02T12:00:00Z'); // Sun
      await service.createAutoSessionWindow(
        {
          roomUid,
          localStartTime: '09:00:00',
          localEndTime: '17:00:00',
          daysOfWeek: ['MON'],
          activeStart: now,
          activeEnd: null,
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      // One AUTO session now covers MON Jun 3 09:00-17:00 UTC.
      const before = (await listSessionsForRoom(roomUid)).filter(
        (s) => s.type === 'AUTO',
      );
      expect(before).toHaveLength(1);
      expect(before[0]!.scheduled_start_time).toEqual(
        new Date('2024-06-03T09:00:00Z'),
      );

      // Act - add a WEEKLY schedule on MON 11:00-12:00 UTC (inside the AUTO window).
      await service.createSchedule(
        {
          roomUid,
          name: 'Midday Break',
          activeStart: new Date(now.getTime() + 1),
          activeEnd: null,
          localStartTime: '11:00:00',
          localEndTime: '12:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert - one SCHEDULED session plus two AUTO sessions bracketing it:
      // AUTO [09:00-11:00], SCHEDULED [11:00-12:00], AUTO [12:00-17:00].
      const sessions = await listSessionsForRoom(roomUid);
      const autos = sessions
        .filter((s) => s.type === 'AUTO')
        .sort(
          (a, b) =>
            a.scheduled_start_time.getTime() - b.scheduled_start_time.getTime(),
        );
      const scheduled = sessions.filter((s) => s.type === 'SCHEDULED');
      expect(scheduled).toHaveLength(1);
      expect(autos).toHaveLength(2);
      expect(autos[0]!.scheduled_start_time).toEqual(
        new Date('2024-06-03T09:00:00Z'),
      );
      expect(autos[0]!.scheduled_end_time).toEqual(
        new Date('2024-06-03T11:00:00Z'),
      );
      expect(autos[1]!.scheduled_start_time).toEqual(
        new Date('2024-06-03T12:00:00Z'),
      );
      expect(autos[1]!.scheduled_end_time).toEqual(
        new Date('2024-06-03T17:00:00Z'),
      );
    });

    it('fills the AUTO session gap after a WEEKLY schedule is deleted', async () => {
      // Arrange - room with AUTO window MON 09:00-17:00 and a SCHEDULED session
      // already splitting it at MON 11:00-12:00.
      const { uid: roomUid } = await insertRoom('UTC', true);
      const now = new Date('2024-06-02T12:00:00Z'); // Sun
      await service.createAutoSessionWindow(
        {
          roomUid,
          localStartTime: '09:00:00',
          localEndTime: '17:00:00',
          daysOfWeek: ['MON'],
          activeStart: now,
          activeEnd: null,
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      const schedule = (await service.createSchedule(
        {
          roomUid,
          name: 'Midday',
          activeStart: new Date(now.getTime() + 1),
          activeEnd: null,
          localStartTime: '11:00:00',
          localEndTime: '12:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      )) as Exclude<
        Awaited<ReturnType<typeof service.createSchedule>>,
        | 'ROOM_NOT_FOUND'
        | 'CONFLICT'
        | 'INVALID_ACTIVE_START'
        | 'INVALID_ACTIVE_END'
        | 'INVALID_LOCAL_TIMES'
        | 'INVALID_FREQUENCY_FIELDS'
      >;
      const before = (await listSessionsForRoom(roomUid)).filter(
        (s) => s.type === 'AUTO',
      );
      expect(before).toHaveLength(2); // two AUTO slots bracketing the SCHEDULED session

      // Act - delete the WEEKLY schedule; reconciler should merge the two AUTO gaps.
      await service.deleteSchedule(schedule.uid, now);

      // Assert - single AUTO session covers the full window MON 09:00-17:00 UTC.
      const after = (await listSessionsForRoom(roomUid)).filter(
        (s) => s.type === 'AUTO',
      );
      expect(after).toHaveLength(1);
      expect(after[0]!.scheduled_start_time).toEqual(
        new Date('2024-06-03T09:00:00Z'),
      );
      expect(after[0]!.scheduled_end_time).toEqual(
        new Date('2024-06-03T17:00:00Z'),
      );
    });
  });

  describe('startSessionEarly - additional error cases', (it) => {
    it('returns ANOTHER_SESSION_ACTIVE when a non-AUTO session is currently active', async () => {
      // Arrange - an ON_DEMAND session currently active (non-AUTO); an upcoming
      // ON_DEMAND session that would otherwise be a valid start-early target.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-03T08:30:00Z');
      await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Active',
          type: 'ON_DEMAND',
          scheduled_start_time: new Date('2024-06-03T08:00:00Z'),
          scheduled_end_time: new Date('2024-06-03T09:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .execute();
      const [upcomingRow] = await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Target',
          type: 'ON_DEMAND',
          scheduled_start_time: new Date('2024-06-03T09:00:00Z'),
          scheduled_end_time: new Date('2024-06-03T10:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .returning('uid')
        .execute();

      // Act
      const result = await service.startSessionEarly(upcomingRow!.uid, now);

      // Assert
      expect(result).toBe('ANOTHER_SESSION_ACTIVE');
    });

    it('returns NOT_FOUND for a missing session UID', async () => {
      // Arrange / Act
      const result = await service.startSessionEarly(NULL_UUID, new Date());

      // Assert
      expect(result).toBe('NOT_FOUND');
    });
  });

  describe('endSessionEarly - additional error cases', (it) => {
    it('returns NOT_FOUND for a missing session UID', async () => {
      // Arrange / Act
      const result = await service.endSessionEarly(NULL_UUID, new Date());

      // Assert
      expect(result).toBe('NOT_FOUND');
    });

    it('returns SESSION_NOT_ACTIVE for an already-ended session', async () => {
      // Arrange - ON_DEMAND session with end_override already set.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-03T10:00:00Z');
      const [row] = await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'Ended',
          type: 'ON_DEMAND',
          scheduled_start_time: new Date('2024-06-03T09:00:00Z'),
          scheduled_end_time: new Date('2024-06-03T17:00:00Z'),
          end_override: new Date('2024-06-03T09:30:00Z'), // ended early already
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .returning('uid')
        .execute();

      // Act
      const result = await service.endSessionEarly(row!.uid, now);

      // Assert
      expect(result).toBe('SESSION_NOT_ACTIVE');
    });
  });

  describe('updateAutoSessionWindow', (it) => {
    it('updates the window in-place and re-reconciles AUTO sessions', async () => {
      // Arrange - one window MON 09:00-12:00 UTC.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z'); // Sun
      const win = await service.createAutoSessionWindow(
        {
          roomUid,
          activeStart: now,
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '12:00:00',
          daysOfWeek: ['MON'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      if (typeof win === 'string') throw new Error('seed window failed');

      // Act - extend the window to 09:00-15:00.
      const result = await service.updateAutoSessionWindow(
        win.uid,
        { localEndTime: '15:00:00' },
        now,
      );

      // Assert - returns the new window; AUTO session reflects the new range.
      expect(typeof result).toBe('object');
      const sessions = await listSessionsForRoom(roomUid);
      const autos = sessions.filter((s) => s.type === 'AUTO');
      expect(autos).toHaveLength(1);
      expect(autos[0]!.scheduled_start_time).toEqual(
        new Date('2024-06-03T09:00:00Z'),
      );
      expect(autos[0]!.scheduled_end_time).toEqual(
        new Date('2024-06-03T15:00:00Z'),
      );
    });

    it('rolls back the delete when the merged window CONFLICTs with another', async () => {
      // Arrange - two non-overlapping windows on different weekdays.
      // Updating window A to overlap B must CONFLICT and not lose A.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z'); // Sun
      const winA = await service.createAutoSessionWindow(
        {
          roomUid,
          activeStart: now,
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '12:00:00',
          daysOfWeek: ['MON'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      if (typeof winA === 'string') throw new Error('seed winA failed');
      const winB = await service.createAutoSessionWindow(
        {
          roomUid,
          activeStart: now,
          activeEnd: null,
          localStartTime: '13:00:00',
          localEndTime: '17:00:00',
          daysOfWeek: ['WED'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      if (typeof winB === 'string') throw new Error('seed winB failed');
      const versionBefore = (await getRoom(roomUid)).room_schedule_version;
      const sessionsBefore = await listSessionsForRoom(roomUid);

      // Act - move winA onto WED 12:00-14:00 (overlaps winB 13:00-17:00).
      const result = await service.updateAutoSessionWindow(
        winA.uid,
        {
          daysOfWeek: ['WED'],
          localStartTime: '12:00:00',
          localEndTime: '14:00:00',
        },
        now,
      );

      // Assert - CONFLICT; both windows still exist; sessions unchanged;
      // room_schedule_version not bumped (transaction rolled back).
      expect(result).toBe('CONFLICT');
      const winAStillThere = await service.findAutoSessionWindowByUid(winA.uid);
      expect(winAStillThere).not.toBe('NOT_FOUND');
      const sessionsAfter = await listSessionsForRoom(roomUid);
      expect(sessionsAfter.map((s) => s.uid).sort()).toEqual(
        sessionsBefore.map((s) => s.uid).sort(),
      );
      const room = await getRoom(roomUid);
      expect(room.room_schedule_version).toEqual(versionBefore);
    });

    it('returns NOT_FOUND when the target window does not exist', async () => {
      // Arrange / Act
      const result = await service.updateAutoSessionWindow(
        NULL_UUID,
        { localEndTime: '15:00:00' },
        new Date('2024-06-02T12:00:00Z'),
      );

      // Assert
      expect(result).toBe('NOT_FOUND');
    });

    it('returns NOT_FOUND when the window is already closed', async () => {
      // Arrange - a window with active_end set in the past.
      const { uid: roomUid } = await insertRoom('UTC');
      const [row] = await dbContext.db
        .insertInto('auto_session_windows')
        .values({
          room_uid: roomUid,
          local_start_time: '09:00:00',
          local_end_time: '12:00:00',
          days_of_week: ['MON'],
          active_start: new Date('2024-05-01T00:00:00Z'),
          active_end: new Date('2024-05-15T00:00:00Z'),
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .returning('uid')
        .execute();

      // Act
      const result = await service.updateAutoSessionWindow(
        row!.uid,
        { localEndTime: '15:00:00' },
        new Date('2024-06-02T12:00:00Z'),
      );

      // Assert
      expect(result).toBe('NOT_FOUND');
    });
  });

  describe('createAutoSessionWindow - INVALID_ACTIVE_END', (it) => {
    it('returns INVALID_ACTIVE_END when activeEnd equals activeStart', async () => {
      // Arrange - zero-length range; previously returned a misleading CONFLICT.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z');
      const activeStart = new Date(now.getTime() + 86_400_000);

      // Act
      const result = await service.createAutoSessionWindow(
        {
          roomUid,
          activeStart,
          activeEnd: activeStart,
          localStartTime: '09:00:00',
          localEndTime: '17:00:00',
          daysOfWeek: ['MON'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert
      expect(result).toBe('INVALID_ACTIVE_END');
    });

    it('returns INVALID_ACTIVE_END when activeEnd precedes activeStart', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z');

      // Act
      const result = await service.createAutoSessionWindow(
        {
          roomUid,
          activeStart: new Date('2024-07-15T00:00:00Z'),
          activeEnd: new Date('2024-07-10T00:00:00Z'),
          localStartTime: '09:00:00',
          localEndTime: '17:00:00',
          daysOfWeek: ['MON'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert
      expect(result).toBe('INVALID_ACTIVE_END');
    });
  });

  describe('updateAutoSessionWindow - INVALID_ACTIVE_END rollback', (it) => {
    it('rolls back the delete when the merged activeEnd would precede activeStart', async () => {
      // Arrange - one open window; flip activeEnd to a value before activeStart.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z');
      const win = await service.createAutoSessionWindow(
        {
          roomUid,
          activeStart: new Date('2024-07-01T00:00:00Z'),
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '17:00:00',
          daysOfWeek: ['MON'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      if (typeof win === 'string') throw new Error('seed window failed');
      const versionBefore = (await getRoom(roomUid)).room_schedule_version;
      const sessionsBefore = await listSessionsForRoom(roomUid);

      // Act - close the window in the past relative to activeStart.
      const result = await service.updateAutoSessionWindow(
        win.uid,
        { activeEnd: new Date('2024-06-15T00:00:00Z') },
        now,
      );

      // Assert - error code returned; window still open; sessions and version
      // untouched (transaction rolled back).
      expect(result).toBe('INVALID_ACTIVE_END');
      const stillThere = await service.findAutoSessionWindowByUid(win.uid);
      if (typeof stillThere === 'string')
        throw new Error('window unexpectedly missing');
      expect(stillThere.activeEnd).toBeNull();
      const sessionsAfter = await listSessionsForRoom(roomUid);
      expect(sessionsAfter.map((s) => s.uid).sort()).toEqual(
        sessionsBefore.map((s) => s.uid).sort(),
      );
      expect((await getRoom(roomUid)).room_schedule_version).toEqual(
        versionBefore,
      );
    });
  });

  describe('adjacent windows - boundary touching', (it) => {
    it('does not detect overlap when window B starts exactly when window A ends', async () => {
      // Arrange - W1 MON 09:00-12:00, W2 MON 12:00-15:00 - no overlap.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z');
      const w1 = await service.createAutoSessionWindow(
        {
          roomUid,
          activeStart: now,
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '12:00:00',
          daysOfWeek: ['MON'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      expect(typeof w1).toBe('object');

      // Act - second window starts when first ends.
      const w2 = await service.createAutoSessionWindow(
        {
          roomUid,
          activeStart: now,
          activeEnd: null,
          localStartTime: '12:00:00',
          localEndTime: '15:00:00',
          daysOfWeek: ['MON'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert - both windows accepted; two AUTO sessions.
      expect(typeof w2).toBe('object');
      const autos = (await listSessionsForRoom(roomUid)).filter(
        (s) => s.type === 'AUTO',
      );
      expect(autos).toHaveLength(2);
      expect(autos[0]!.scheduled_start_time).toEqual(
        new Date('2024-06-03T09:00:00Z'),
      );
      expect(autos[0]!.scheduled_end_time).toEqual(
        new Date('2024-06-03T12:00:00Z'),
      );
      expect(autos[1]!.scheduled_start_time).toEqual(
        new Date('2024-06-03T12:00:00Z'),
      );
      expect(autos[1]!.scheduled_end_time).toEqual(
        new Date('2024-06-03T15:00:00Z'),
      );
    });
  });

  describe('updateSchedule - rollback on validation errors', (it) => {
    it('rolls back the schedule and sessions when INVALID_LOCAL_TIMES is returned', async () => {
      // Arrange - a schedule with a future session.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z'); // Sun
      const schedule = await service.createSchedule(
        {
          roomUid,
          name: 'Base',
          activeStart: new Date(now.getTime() + 1),
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '10:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      if (typeof schedule === 'string') throw new Error('seed failed');
      const versionBefore = (await getRoom(roomUid)).room_schedule_version;
      const sessionsBefore = await listSessionsForRoom(roomUid);

      // Act - merged localStartTime == localEndTime triggers INVALID_LOCAL_TIMES
      // AFTER `_doDeleteSchedule` has already run.
      const result = await service.updateSchedule(
        schedule.uid,
        { localEndTime: '09:00:00' },
        now,
      );

      // Assert - error returned; schedule still open, sessions unchanged,
      // room version not bumped.
      expect(result).toBe('INVALID_LOCAL_TIMES');
      const stillOpen = await service.findScheduleByUid(schedule.uid);
      expect(stillOpen).not.toBe('NOT_FOUND');
      if (typeof stillOpen === 'string')
        throw new Error('schedule unexpectedly missing');
      expect(stillOpen.activeEnd).toBeNull();
      expect(stillOpen.localStartTime).toBe('09:00:00');
      expect(stillOpen.localEndTime).toBe('10:00:00');
      const sessionsAfter = await listSessionsForRoom(roomUid);
      expect(sessionsAfter.map((s) => s.uid).sort()).toEqual(
        sessionsBefore.map((s) => s.uid).sort(),
      );
      expect((await getRoom(roomUid)).room_schedule_version).toEqual(
        versionBefore,
      );
    });

    it('rolls back the schedule and sessions when INVALID_FREQUENCY_FIELDS is returned', async () => {
      // Arrange
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z');
      const schedule = await service.createSchedule(
        {
          roomUid,
          name: 'Base',
          activeStart: new Date(now.getTime() + 1),
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '10:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      if (typeof schedule === 'string') throw new Error('seed failed');
      const versionBefore = (await getRoom(roomUid)).room_schedule_version;

      // Act - empty daysOfWeek with WEEKLY triggers INVALID_FREQUENCY_FIELDS.
      const result = await service.updateSchedule(
        schedule.uid,
        { daysOfWeek: [] },
        now,
      );

      // Assert
      expect(result).toBe('INVALID_FREQUENCY_FIELDS');
      const stillOpen = await service.findScheduleByUid(schedule.uid);
      if (typeof stillOpen === 'string')
        throw new Error('schedule unexpectedly missing');
      expect(stillOpen.activeEnd).toBeNull();
      expect(stillOpen.daysOfWeek).toEqual(['MON']);
      expect((await getRoom(roomUid)).room_schedule_version).toEqual(
        versionBefore,
      );
    });

    it('rolls back the schedule when INVALID_ACTIVE_START is returned (no new activeStart on past schedule)', async () => {
      // Arrange - a schedule with activeStart in the past (seeded directly).
      const { uid: roomUid } = await insertRoom('UTC');
      const pastStart = new Date('2024-05-01T00:00:00Z');
      const now = new Date('2024-06-05T12:00:00Z');
      const schedule = await repository.insertSchedule(repository.db, {
        roomUid,
        name: 'Past',
        activeStart: pastStart,
        activeEnd: null,
        anchorStart: pastStart,
        localStartTime: '09:00:00',
        localEndTime: '10:00:00',
        frequency: 'ONCE',
        daysOfWeek: null,
        joinCodeScopes: [],
        transcriptionProviderId: 'whisper',
        transcriptionStreamConfig: {},
      });
      const versionBefore = (await getRoom(roomUid)).room_schedule_version;

      // Act - rename only; merged activeStart = pastStart <= now triggers
      // INVALID_ACTIVE_START after `_doDeleteSchedule` has run.
      const result = await service.updateSchedule(
        schedule.uid,
        { name: 'Renamed' },
        now,
      );

      // Assert - the original schedule is preserved (still open, original name).
      expect(result).toBe('INVALID_ACTIVE_START');
      const stillOpen = await service.findScheduleByUid(schedule.uid);
      if (typeof stillOpen === 'string')
        throw new Error('schedule unexpectedly missing');
      expect(stillOpen.activeEnd).toBeNull();
      expect(stillOpen.name).toBe('Past');
      expect((await getRoom(roomUid)).room_schedule_version).toEqual(
        versionBefore,
      );
    });
  });

  describe('reconciler - active AUTO session preservation', (it) => {
    it('preserves the active AUTO row in place and shifts its end when the window is shortened', async () => {
      // Arrange - create the window before the window's daily start so the
      // AUTO is materialized with `scheduled_start = window_start = 09:00`.
      // Then advance to mid-window and update; the AUTO must remain in
      // place (same uid) with its end shifted from 17:00 to 15:00.
      const { uid: roomUid } = await insertRoom('UTC');
      const createNow = new Date('2024-06-03T07:00:00Z'); // Mon, before 09:00
      const win = await service.createAutoSessionWindow(
        {
          roomUid,
          activeStart: new Date('2024-06-03T07:00:00Z'),
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '17:00:00',
          daysOfWeek: ['MON'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        createNow,
      );
      if (typeof win === 'string') throw new Error('seed window failed');

      const sessionsBefore = await listSessionsForRoom(roomUid);
      const activeAuto = sessionsBefore.find((s) => s.type === 'AUTO');
      if (!activeAuto) throw new Error('expected one AUTO session');
      // Sanity: AUTO row spans the full window range.
      expect(activeAuto.scheduled_start_time).toEqual(
        new Date('2024-06-03T09:00:00Z'),
      );
      expect(activeAuto.scheduled_end_time).toEqual(
        new Date('2024-06-03T17:00:00Z'),
      );
      const versionBefore = Number(activeAuto.session_config_version);

      // Act - mid-window update: shorten the window to 09:00-15:00.
      const updateNow = new Date('2024-06-03T12:00:00Z');
      const result = await service.updateAutoSessionWindow(
        win.uid,
        { localEndTime: '15:00:00' },
        updateNow,
      );
      if (typeof result === 'string')
        throw new Error('update unexpectedly failed: ' + result);

      // Assert - the active AUTO row is preserved (same uid) with its
      // scheduled_end_time shifted from 17:00 to 15:00; session_config_version
      // bumped; no end_override (the AUTO continues running). Next-MON AUTO
      // for 2024-06-10 is also created by the materializer and is fine.
      const sessionsAfter = await listSessionsForRoom(roomUid);
      const sameRow = sessionsAfter.find((s) => s.uid === activeAuto.uid);
      if (!sameRow) throw new Error('active AUTO row was deleted');
      expect(sameRow.scheduled_end_time).toEqual(
        new Date('2024-06-03T15:00:00Z'),
      );
      expect(sameRow.end_override).toBeNull();
      expect(Number(sameRow.session_config_version)).toBeGreaterThan(
        versionBefore,
      );
    });

    it('ends the active AUTO via end_override when the new window does not cover its start', async () => {
      // Arrange - AUTO running 09:00-17:00 since 09:00 (active at updateNow=12:00).
      const { uid: roomUid } = await insertRoom('UTC');
      const createNow = new Date('2024-06-03T07:00:00Z');
      const win = await service.createAutoSessionWindow(
        {
          roomUid,
          activeStart: new Date('2024-06-03T07:00:00Z'),
          activeEnd: null,
          localStartTime: '09:00:00',
          localEndTime: '17:00:00',
          daysOfWeek: ['MON'],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        createNow,
      );
      if (typeof win === 'string') throw new Error('seed window failed');
      const activeAuto = (await listSessionsForRoom(roomUid)).find(
        (s) => s.type === 'AUTO',
      );
      if (!activeAuto) throw new Error('expected one AUTO session');
      const versionBefore = Number(activeAuto.session_config_version);

      // Act - move the window to TUE so MON 12:00 is no longer covered.
      const updateNow = new Date('2024-06-03T12:00:00Z');
      const result = await service.updateAutoSessionWindow(
        win.uid,
        { daysOfWeek: ['TUE'] },
        updateNow,
      );
      if (typeof result === 'string')
        throw new Error('update unexpectedly failed: ' + result);

      // Assert - the active AUTO row is preserved (same uid) but ended
      // cleanly via end_override = updateNow.
      const sessionsAfter = await listSessionsForRoom(roomUid);
      const sameRow = sessionsAfter.find((s) => s.uid === activeAuto.uid);
      if (!sameRow) throw new Error('active AUTO row was deleted');
      expect(sameRow.end_override).toEqual(updateNow);
      expect(Number(sameRow.session_config_version)).toBeGreaterThan(
        versionBefore,
      );
      // No replacement AUTO row was inserted on the original (MON) day.
      // Next-TUE AUTOs are legitimate per the new window and ignored here.
      const newMonAutos = sessionsAfter.filter(
        (s) =>
          s.type === 'AUTO' &&
          s.uid !== activeAuto.uid &&
          s.scheduled_start_time.getUTCFullYear() === 2024 &&
          s.scheduled_start_time.getUTCMonth() === 5 &&
          s.scheduled_start_time.getUTCDate() === 3,
      );
      expect(newMonAutos).toHaveLength(0);
    });
  });

  describe('wrap-around midnight schedules', (it) => {
    it('detects CONFLICT when a wrapping schedule overlaps the next-morning of a non-wrapping one', async () => {
      // Arrange - Schedule A: FRI 22:00 -> SAT 02:00 (wraps midnight).
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-03T12:00:00Z'); // Mon
      const activeStart = new Date(now.getTime() + 1);
      const a = await service.createSchedule(
        {
          roomUid,
          name: 'Wrap',
          activeStart,
          activeEnd: null,
          localStartTime: '22:00:00',
          localEndTime: '02:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['FRI'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      expect(typeof a).toBe('object');

      // Act - Schedule B: SAT 01:00 -> 03:00 (overlaps A's 01:00-02:00 SAT tail).
      const result = await service.createSchedule(
        {
          roomUid,
          name: 'NextMorning',
          activeStart,
          activeEnd: null,
          localStartTime: '01:00:00',
          localEndTime: '03:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['SAT'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert
      expect(result).toBe('CONFLICT');
    });

    it('does not detect conflict when a wrapping schedule ends exactly when the next-morning one begins', async () => {
      // Arrange - Schedule A: FRI 22:00 -> SAT 02:00 (wraps midnight).
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-03T12:00:00Z');
      const activeStart = new Date(now.getTime() + 1);
      const a = await service.createSchedule(
        {
          roomUid,
          name: 'Wrap',
          activeStart,
          activeEnd: null,
          localStartTime: '22:00:00',
          localEndTime: '02:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['FRI'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      expect(typeof a).toBe('object');

      // Act - Schedule B: SAT 02:00 -> 04:00 (boundary, no overlap with A).
      const result = await service.createSchedule(
        {
          roomUid,
          name: 'NextMorning',
          activeStart,
          activeEnd: null,
          localStartTime: '02:00:00',
          localEndTime: '04:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['SAT'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert - B accepted; both schedules produce sessions.
      expect(typeof result).toBe('object');
    });

    it('materializes a wrap-around session as a single record spanning midnight', async () => {
      // Arrange - FRI 22:00 -> SAT 02:00 (UTC) for one week.
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-03T12:00:00Z'); // Mon
      const activeStart = new Date(now.getTime() + 1);

      // Act
      const result = await service.createSchedule(
        {
          roomUid,
          name: 'Wrap',
          activeStart,
          activeEnd: null,
          localStartTime: '22:00:00',
          localEndTime: '02:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['FRI'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );

      // Assert - one SCHEDULED session: 2024-06-07 22:00 -> 2024-06-08 02:00 UTC.
      expect(typeof result).toBe('object');
      const sessions = (await listSessionsForRoom(roomUid)).filter(
        (s) => s.type === 'SCHEDULED',
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.scheduled_start_time).toEqual(
        new Date('2024-06-07T22:00:00Z'),
      );
      expect(sessions[0]!.scheduled_end_time).toEqual(
        new Date('2024-06-08T02:00:00Z'),
      );
    });
  });

  describe('multiple on-demand sessions in sequence', (it) => {
    it('allows a second on-demand session after the first is ended early', async () => {
      // Arrange - first on-demand at now=10:00.
      const { uid: roomUid } = await insertRoom('UTC', false);
      const t1 = new Date('2024-06-03T10:00:00Z');
      const od1 = await service.createOnDemandSession(
        {
          roomUid,
          name: 'OD1',
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        t1,
      );
      if (typeof od1 === 'string') throw new Error('seed od1 failed');

      // End OD1 early at t2.
      const t2 = new Date('2024-06-03T11:00:00Z');
      const ended = await service.endSessionEarly(od1.uid, t2);
      expect(typeof ended).toBe('object');

      // Act - create OD2 at the same moment.
      const od2 = await service.createOnDemandSession(
        {
          roomUid,
          name: 'OD2',
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        t2,
      );

      // Assert - OD2 succeeds; OD1 is ENDED, OD2 is ACTIVE.
      expect(typeof od2).toBe('object');
      const all = (await listSessionsForRoom(roomUid)).filter(
        (s) => s.type === 'ON_DEMAND',
      );
      expect(all).toHaveLength(2);
    });

    it('rejects a second on-demand session while the first is still active', async () => {
      // Arrange - first on-demand currently active.
      const { uid: roomUid } = await insertRoom('UTC', false);
      const now = new Date('2024-06-03T10:00:00Z');
      const od1 = await service.createOnDemandSession(
        {
          roomUid,
          name: 'OD1',
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      if (typeof od1 === 'string') throw new Error('seed od1 failed');

      // Act - try to create OD2 while OD1 still active.
      const od2 = await service.createOnDemandSession(
        {
          roomUid,
          name: 'OD2',
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        new Date('2024-06-03T10:30:00Z'),
      );

      // Assert
      expect(od2).toBe('ANOTHER_SESSION_ACTIVE');
    });
  });

  describe('on-demand realignment - createSchedule and deleteSchedule', (it) => {
    it('shrinks an open-ended on-demand session when a future schedule is created', async () => {
      // Arrange - a room with no other sessions; create an open-ended ON_DEMAND
      // (scheduled_end_time = null) running now.
      const { uid: roomUid } = await insertRoom('UTC', false);
      const now = new Date('2024-06-03T10:00:00Z'); // Mon
      const [od] = await dbContext.db
        .insertInto('sessions')
        .values({
          room_uid: roomUid,
          name: 'On-demand',
          type: 'ON_DEMAND',
          scheduled_start_time: new Date('2024-06-03T09:00:00Z'),
          scheduled_end_time: null, // open-ended
          transcription_provider_id: 'whisper',
          transcription_stream_config: {},
        })
        .returning(['uid', 'session_config_version'])
        .execute();
      const versionBefore = Number(od!.session_config_version);

      // Act - create a future SCHEDULED occurrence at 14:00-15:00 today.
      const schedActiveStart = new Date(now.getTime() + 1);
      const result = await service.createSchedule(
        {
          roomUid,
          name: 'Blocker',
          activeStart: schedActiveStart,
          activeEnd: null,
          localStartTime: '14:00:00',
          localEndTime: '15:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      expect(typeof result).toBe('object');

      // Assert - on-demand's scheduled_end_time now equals the schedule's start.
      const odAfter = await dbContext.db
        .selectFrom('sessions')
        .select(['scheduled_end_time', 'session_config_version'])
        .where('uid', '=', od!.uid)
        .executeTakeFirstOrThrow();
      expect(odAfter.scheduled_end_time).toEqual(
        new Date('2024-06-03T14:00:00Z'),
      );
      expect(Number(odAfter.session_config_version)).toBeGreaterThan(
        versionBefore,
      );
    });

    it('repins on-demand to the next-but-one session when its pinned schedule is deleted', async () => {
      // Arrange - two future schedules: A at 14:00 and B at 16:00 (both MON).
      // On-demand pins to A; deleting A should re-pin to B.
      const { uid: roomUid } = await insertRoom('UTC', false);
      const now = new Date('2024-06-03T10:00:00Z'); // Mon
      const schedActiveStart = new Date(now.getTime() + 1);
      const schedA = await service.createSchedule(
        {
          roomUid,
          name: 'A',
          activeStart: schedActiveStart,
          activeEnd: null,
          localStartTime: '14:00:00',
          localEndTime: '15:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      if (typeof schedA === 'string') throw new Error('seed A failed');
      const schedB = await service.createSchedule(
        {
          roomUid,
          name: 'B',
          activeStart: schedActiveStart,
          activeEnd: null,
          localStartTime: '16:00:00',
          localEndTime: '17:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      if (typeof schedB === 'string') throw new Error('seed B failed');

      const od = await service.createOnDemandSession(
        {
          roomUid,
          name: 'On-demand',
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      if (typeof od === 'string') throw new Error('seed on-demand failed');
      // Sanity: pinned to A.
      expect(od.scheduledEndTime).toEqual(new Date('2024-06-03T14:00:00Z'));

      // Act - delete A; the on-demand should re-pin to B (16:00).
      const delResult = await service.deleteSchedule(schedA.uid, now);
      expect(delResult).toBeUndefined();

      // Assert
      const odAfter = await dbContext.db
        .selectFrom('sessions')
        .select(['scheduled_end_time'])
        .where('uid', '=', od.uid)
        .executeTakeFirstOrThrow();
      expect(odAfter.scheduled_end_time).toEqual(
        new Date('2024-06-03T16:00:00Z'),
      );
    });

    it('reopens an on-demand session when its pinned next-schedule is deleted', async () => {
      // Arrange - schedule producing a future SCHEDULED session, then create
      // an on-demand pinned to that schedule's start.
      const { uid: roomUid } = await insertRoom('UTC', false);
      const now = new Date('2024-06-03T10:00:00Z'); // Mon
      const created = await service.createSchedule(
        {
          roomUid,
          name: 'Future',
          activeStart: new Date(now.getTime() + 1),
          activeEnd: null,
          localStartTime: '14:00:00',
          localEndTime: '15:00:00',
          frequency: 'WEEKLY',
          daysOfWeek: ['MON'],
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      if (typeof created === 'string') throw new Error('seed schedule failed');

      const odResult = await service.createOnDemandSession(
        {
          roomUid,
          name: 'On-demand',
          joinCodeScopes: [],
          transcriptionProviderId: 'whisper',
          transcriptionStreamConfig: {},
        },
        now,
      );
      if (typeof odResult === 'string')
        throw new Error('seed on-demand failed');
      // Sanity: on-demand was pinned to the schedule's start.
      expect(odResult.scheduledEndTime).toEqual(
        new Date('2024-06-03T14:00:00Z'),
      );
      const versionBefore = odResult.sessionConfigVersion;

      // Act - delete the schedule; the on-demand should re-pin to null
      // (no next non-AUTO session in the room).
      const delResult = await service.deleteSchedule(created.uid, now);
      expect(delResult).toBeUndefined();

      // Assert - on-demand's scheduled_end_time is now null (open-ended).
      const odAfter = await dbContext.db
        .selectFrom('sessions')
        .select(['scheduled_end_time', 'session_config_version'])
        .where('uid', '=', odResult.uid)
        .executeTakeFirstOrThrow();
      expect(odAfter.scheduled_end_time).toBeNull();
      expect(Number(odAfter.session_config_version)).toBeGreaterThan(
        versionBefore,
      );
    });
  });
});
