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
        'ROOM_NOT_FOUND' | 'CONFLICT' | 'INVALID_ACTIVE_START'
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
        'ROOM_NOT_FOUND' | 'CONFLICT' | 'INVALID_ACTIVE_START'
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

    it('returns CONFLICT when activeEnd is at or before activeStart', async () => {
      // Arrange / Act
      const { uid: roomUid } = await insertRoom('UTC');
      const now = new Date('2024-06-02T12:00:00Z');
      const activeStart = new Date(now.getTime() + 1);
      const result = await service.createSchedule(
        {
          roomUid,
          name: 'Inverted',
          activeStart,
          activeEnd: activeStart, // zero-length range — DB CHECK would reject too
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
      expect(result).toBe('CONFLICT');
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

      // Act - a second WEEKLY schedule on Mondays 14:30-15:30 — overlaps.
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
      expect(initialSessions.filter((s) => s.type === 'SCHEDULED')).toHaveLength(
        3,
      );
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
        'ROOM_NOT_FOUND' | 'CONFLICT' | 'INVALID_ACTIVE_START'
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
        'NOT_FOUND' | 'CONFLICT' | 'INVALID_ACTIVE_START'
      >;
      expect(updated.uid).not.toBe(original.uid);
      expect(updated.name).toBe('Renamed');
      // Anchor preserved verbatim from the original — biweekly cadence is
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
        'ROOM_NOT_FOUND' | 'CONFLICT' | 'INVALID_ACTIVE_START'
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
});
