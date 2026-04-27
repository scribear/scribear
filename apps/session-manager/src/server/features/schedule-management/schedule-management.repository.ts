import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';

import type {
  DB,
  DayOfWeek,
  Json,
  ScheduleFrequency,
  SessionScope,
  SessionType,
} from '@scribear/scribear-db';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

/** Either the top-level Kysely instance or an active transaction handle. */
export type DBOrTrx = Kysely<DB> | Transaction<DB>;

const SCHEDULE_COLUMNS = [
  'uid',
  'room_uid',
  'name',
  'active_start',
  'active_end',
  'local_start_time',
  'local_end_time',
  'frequency',
  'days_of_week',
  'join_code_scopes',
  'transcription_provider_id',
  'transcription_stream_config',
  'created_at',
] as const;

const WINDOW_COLUMNS = [
  'uid',
  'room_uid',
  'local_start_time',
  'local_end_time',
  'days_of_week',
  'transcription_provider_id',
  'transcription_stream_config',
  'active_start',
  'active_end',
  'created_at',
] as const;

const SESSION_COLUMNS = [
  'uid',
  'room_uid',
  'name',
  'type',
  'scheduled_session_uid',
  'scheduled_start_time',
  'scheduled_end_time',
  'start_override',
  'end_override',
  'join_code_scopes',
  'transcription_provider_id',
  'transcription_stream_config',
  'session_config_version',
  'created_at',
] as const;

interface ScheduleRow {
  uid: string;
  room_uid: string;
  name: string;
  active_start: Date;
  active_end: Date | null;
  local_start_time: string;
  local_end_time: string;
  frequency: ScheduleFrequency;
  days_of_week: DayOfWeek[] | null;
  join_code_scopes: SessionScope[];
  transcription_provider_id: string;
  transcription_stream_config: Json;
  created_at: Date;
}

interface WindowRow {
  uid: string;
  room_uid: string;
  local_start_time: string;
  local_end_time: string;
  days_of_week: DayOfWeek[];
  transcription_provider_id: string;
  transcription_stream_config: Json;
  active_start: Date;
  active_end: Date | null;
  created_at: Date;
}

interface SessionRow {
  uid: string;
  room_uid: string;
  name: string;
  type: SessionType;
  scheduled_session_uid: string | null;
  scheduled_start_time: Date;
  scheduled_end_time: Date | null;
  start_override: Date | null;
  end_override: Date | null;
  join_code_scopes: SessionScope[];
  transcription_provider_id: string;
  transcription_stream_config: Json;
  session_config_version: string;
  created_at: Date;
}

/** A persisted `session_schedules` row mapped to camelCase. */
export interface Schedule {
  uid: string;
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
  createdAt: Date;
}

/** A persisted `auto_session_windows` row mapped to camelCase. */
export interface AutoSessionWindow {
  uid: string;
  roomUid: string;
  localStartTime: string;
  localEndTime: string;
  daysOfWeek: DayOfWeek[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: Json;
  activeStart: Date;
  activeEnd: Date | null;
  createdAt: Date;
}

/**
 * A persisted `sessions` row mapped to camelCase, with `effectiveStart` and
 * `effectiveEnd` precomputed from the override / scheduled columns.
 */
export interface Session {
  uid: string;
  roomUid: string;
  name: string;
  type: SessionType;
  scheduledSessionUid: string | null;
  scheduledStartTime: Date;
  scheduledEndTime: Date | null;
  startOverride: Date | null;
  endOverride: Date | null;
  joinCodeScopes: SessionScope[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: Json;
  sessionConfigVersion: number;
  createdAt: Date;
  /** Convenience: COALESCE(start_override, scheduled_start_time). */
  effectiveStart: Date;
  /** Convenience: COALESCE(end_override, scheduled_end_time). */
  effectiveEnd: Date | null;
}

/** Fields required to insert a new `sessions` row via `insertSessions`. */
export interface SessionInsert {
  roomUid: string;
  name: string;
  type: SessionType;
  scheduledSessionUid: string | null;
  scheduledStartTime: Date;
  scheduledEndTime: Date | null;
  joinCodeScopes: SessionScope[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: Json;
}

/**
 * Parses a PostgreSQL enum-array value returned by the pg driver. Custom enum
 * arrays (day_of_week[], session_scope[]) are not registered in the type OID
 * table, so the driver returns them as raw `{X,Y}` strings instead of JS
 * arrays. This helper handles both shapes.
 */
function parsePgEnumArray(value: unknown): string[] {
  if (Array.isArray(value)) return value as string[];
  if (typeof value !== 'string' || value === '{}') return [];
  return value.slice(1, -1).split(',');
}

/**
 * Maps a `session_schedules` row to a `Schedule`. Decodes the raw pg enum-array
 * shape returned for `days_of_week` and `join_code_scopes`.
 * @param row The database row to map.
 * @returns The mapped schedule.
 */
function mapSchedule(row: ScheduleRow): Schedule {
  return {
    uid: row.uid,
    roomUid: row.room_uid,
    name: row.name,
    activeStart: row.active_start,
    activeEnd: row.active_end,
    localStartTime: row.local_start_time,
    localEndTime: row.local_end_time,
    frequency: row.frequency,
    daysOfWeek:
      row.days_of_week !== null
        ? (parsePgEnumArray(row.days_of_week) as DayOfWeek[])
        : null,
    joinCodeScopes: parsePgEnumArray(row.join_code_scopes) as SessionScope[],
    transcriptionProviderId: row.transcription_provider_id,
    transcriptionStreamConfig: row.transcription_stream_config,
    createdAt: row.created_at,
  };
}

/**
 * Maps an `auto_session_windows` row to an `AutoSessionWindow`. Decodes the raw
 * pg enum-array shape returned for `days_of_week`.
 * @param row The database row to map.
 * @returns The mapped auto-session window.
 */
function mapWindow(row: WindowRow): AutoSessionWindow {
  return {
    uid: row.uid,
    roomUid: row.room_uid,
    localStartTime: row.local_start_time,
    localEndTime: row.local_end_time,
    daysOfWeek: parsePgEnumArray(row.days_of_week) as DayOfWeek[],
    transcriptionProviderId: row.transcription_provider_id,
    transcriptionStreamConfig: row.transcription_stream_config,
    activeStart: row.active_start,
    activeEnd: row.active_end,
    createdAt: row.created_at,
  };
}

/**
 * Maps a `sessions` row to a `Session`. Decodes `join_code_scopes`, narrows
 * the bigint `session_config_version` to a JS number, and precomputes
 * `effectiveStart` / `effectiveEnd` from the override / scheduled columns.
 * @param row The database row to map.
 * @returns The mapped session.
 */
function mapSession(row: SessionRow): Session {
  return {
    uid: row.uid,
    roomUid: row.room_uid,
    name: row.name,
    type: row.type,
    scheduledSessionUid: row.scheduled_session_uid,
    scheduledStartTime: row.scheduled_start_time,
    scheduledEndTime: row.scheduled_end_time,
    startOverride: row.start_override,
    endOverride: row.end_override,
    joinCodeScopes: parsePgEnumArray(row.join_code_scopes) as SessionScope[],
    transcriptionProviderId: row.transcription_provider_id,
    transcriptionStreamConfig: row.transcription_stream_config,
    sessionConfigVersion: Number(row.session_config_version),
    createdAt: row.created_at,
    effectiveStart: row.start_override ?? row.scheduled_start_time,
    effectiveEnd: row.end_override ?? row.scheduled_end_time,
  };
}

/**
 * Data-access primitives for schedule management. All methods take a
 * `Kysely<DB> | Transaction<DB>` first arg so the caller (typically the
 * service) controls the transaction boundary; this repository never opens
 * one of its own.
 */
export class ScheduleManagementRepository {
  private _dbClient: AppDependencies['dbClient'];

  constructor(dbClient: AppDependencies['dbClient']) {
    this._dbClient = dbClient;
  }

  /** Underlying kysely client for callers that need to run reads outside a transaction. */
  get db(): Kysely<DB> {
    return this._dbClient.db;
  }

  /**
   * Acquires a `FOR UPDATE` lock on the rooms row, serializing all schedule
   * and window writes for the room within the caller's transaction. Returns
   * the row's identity, timezone, and auto-session master switch, or
   * undefined if the room does not exist.
   */
  async lockRoom(
    db: DBOrTrx,
    roomUid: string,
  ): Promise<
    { uid: string; timezone: string; autoSessionEnabled: boolean } | undefined
  > {
    const row = await db
      .selectFrom('rooms')
      .select(['uid', 'timezone', 'auto_session_enabled'])
      .where('uid', '=', roomUid)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return undefined;
    return {
      uid: row.uid,
      timezone: row.timezone,
      autoSessionEnabled: row.auto_session_enabled,
    };
  }

  /**
   * Updates schedule-affecting fields on the rooms row. Only the fields
   * present in `data` are written; omitted fields are left unchanged.
   * @param db Kysely client or transaction.
   * @param roomUid The room to update.
   * @param data Fields to update.
   */
  async updateRoomScheduleConfig(
    db: DBOrTrx,
    roomUid: string,
    data: { timezone?: string; autoSessionEnabled?: boolean },
  ): Promise<void> {
    const updates: { timezone?: string; auto_session_enabled?: boolean } = {};
    if (data.timezone !== undefined) updates.timezone = data.timezone;
    if (data.autoSessionEnabled !== undefined) {
      updates.auto_session_enabled = data.autoSessionEnabled;
    }
    if (Object.keys(updates).length === 0) return;
    await db
      .updateTable('rooms')
      .set(updates)
      .where('uid', '=', roomUid)
      .execute();
  }

  /**
   * Increments `rooms.room_schedule_version` and returns the new value.
   * Callers invoke this once per write operation so polling clients can
   * detect schedule changes; the returned version drives the
   * `schedule-changes-stream` SSE event.
   * @param db Kysely client or transaction.
   * @param roomUid The room whose version counter to bump.
   * @returns The new `room_schedule_version`.
   */
  async bumpScheduleVersion(db: DBOrTrx, roomUid: string): Promise<number> {
    const row = await db
      .updateTable('rooms')
      .set({ room_schedule_version: sql<string>`room_schedule_version + 1` })
      .where('uid', '=', roomUid)
      .returning('room_schedule_version')
      .executeTakeFirstOrThrow();
    return Number(row.room_schedule_version);
  }

  /**
   * Stamps `rooms.last_materialized_at`. Used to record when the materialization
   * window was last refreshed so the materializer worker can skip rooms that
   * are already current.
   * @param db Kysely client or transaction.
   * @param roomUid The room to stamp.
   * @param now The instant to write.
   */
  async touchLastMaterializedAt(
    db: DBOrTrx,
    roomUid: string,
    now: Date,
  ): Promise<void> {
    await db
      .updateTable('rooms')
      .set({ last_materialized_at: now })
      .where('uid', '=', roomUid)
      .execute();
  }

  /**
   * Fetches a single schedule by UID.
   * @param db Kysely client or transaction.
   * @param uid The schedule's unique identifier.
   * @returns The mapped schedule, or `undefined` if not found.
   */
  async findScheduleByUid(
    db: DBOrTrx,
    uid: string,
  ): Promise<Schedule | undefined> {
    const row = await db
      .selectFrom('session_schedules')
      .select(SCHEDULE_COLUMNS)
      .where('uid', '=', uid)
      .executeTakeFirst();
    return row ? mapSchedule(row) : undefined;
  }

  /**
   * Returns schedules whose `[active_start, active_end)` overlaps `[range.from, range.to)`.
   * `null` `active_end` is treated as +infinity; `null` `range.to` is treated as +infinity.
   */
  async findSchedulesOverlapping(
    db: DBOrTrx,
    roomUid: string,
    range: { from: Date; to: Date | null },
    opts?: { excludeUid?: string },
  ): Promise<Schedule[]> {
    let q = db
      .selectFrom('session_schedules')
      .select(SCHEDULE_COLUMNS)
      .where('room_uid', '=', roomUid)
      .where((eb) =>
        eb.or([
          eb('active_end', 'is', null),
          eb('active_end', '>', range.from),
        ]),
      );

    if (range.to !== null) {
      q = q.where('active_start', '<', range.to);
    }
    if (opts?.excludeUid !== undefined) {
      q = q.where('uid', '!=', opts.excludeUid);
    }

    const rows = await q.orderBy('active_start', 'asc').execute();
    return rows.map((r) => mapSchedule(r));
  }

  /**
   * Inserts a new `session_schedules` row and returns the mapped result.
   * @param db Kysely client or transaction.
   * @param data Fields to insert.
   * @returns The newly created schedule.
   */
  async insertSchedule(
    db: DBOrTrx,
    data: {
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
    },
  ): Promise<Schedule> {
    const row = await db
      .insertInto('session_schedules')
      .values({
        room_uid: data.roomUid,
        name: data.name,
        active_start: data.activeStart,
        active_end: data.activeEnd,
        local_start_time: data.localStartTime,
        local_end_time: data.localEndTime,
        frequency: data.frequency,
        days_of_week: data.daysOfWeek,
        join_code_scopes: data.joinCodeScopes,
        transcription_provider_id: data.transcriptionProviderId,
        transcription_stream_config: data.transcriptionStreamConfig,
      })
      .returning(SCHEDULE_COLUMNS)
      .executeTakeFirstOrThrow();
    return mapSchedule(row);
  }

  /**
   * Sets `active_end` on a still-open schedule. No-op (returns false) if the
   * row is missing or already closed.
   */
  async updateScheduleActiveEnd(
    db: DBOrTrx,
    uid: string,
    activeEnd: Date,
  ): Promise<boolean> {
    const result = await db
      .updateTable('session_schedules')
      .set({ active_end: activeEnd })
      .where('uid', '=', uid)
      .where('active_end', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /** Hard-delete; cascades to sessions via the FK on `sessions.scheduled_session_uid`. */
  async deleteScheduleHard(db: DBOrTrx, uid: string): Promise<boolean> {
    const result = await db
      .deleteFrom('session_schedules')
      .where('uid', '=', uid)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  /**
   * Fetches a single auto-session window by UID.
   * @param db Kysely client or transaction.
   * @param uid The window's unique identifier.
   * @returns The mapped window, or `undefined` if not found.
   */
  async findWindowByUid(
    db: DBOrTrx,
    uid: string,
  ): Promise<AutoSessionWindow | undefined> {
    const row = await db
      .selectFrom('auto_session_windows')
      .select(WINDOW_COLUMNS)
      .where('uid', '=', uid)
      .executeTakeFirst();
    return row ? mapWindow(row) : undefined;
  }

  /**
   * Returns auto-session windows whose `[active_start, active_end)` overlaps
   * `[range.from, range.to)`. `null` `active_end` is treated as +infinity; `null`
   * `range.to` is treated as +infinity.
   * @param db Kysely client or transaction.
   * @param roomUid Room whose windows to scan.
   * @param range Time range to test for overlap; `to: null` extends to +infinity.
   * @param opts.excludeUid Optional window UID to exclude (e.g. when re-checking the row being updated).
   */
  async findWindowsOverlapping(
    db: DBOrTrx,
    roomUid: string,
    range: { from: Date; to: Date | null },
    opts?: { excludeUid?: string },
  ): Promise<AutoSessionWindow[]> {
    let q = db
      .selectFrom('auto_session_windows')
      .select(WINDOW_COLUMNS)
      .where('room_uid', '=', roomUid)
      .where((eb) =>
        eb.or([
          eb('active_end', 'is', null),
          eb('active_end', '>', range.from),
        ]),
      );

    if (range.to !== null) {
      q = q.where('active_start', '<', range.to);
    }
    if (opts?.excludeUid !== undefined) {
      q = q.where('uid', '!=', opts.excludeUid);
    }

    const rows = await q.orderBy('active_start', 'asc').execute();
    return rows.map(mapWindow);
  }

  /**
   * Inserts a new `auto_session_windows` row and returns the mapped result.
   * When `activeStart` is omitted the database default `now()` is used.
   * @param db Kysely client or transaction.
   * @param data Fields to insert; omitted optional fields default to `null`.
   * @returns The newly created window.
   */
  async insertWindow(
    db: DBOrTrx,
    data: {
      roomUid: string;
      localStartTime: string;
      localEndTime: string;
      daysOfWeek: DayOfWeek[];
      activeStart: Date;
      activeEnd: Date | null;
      transcriptionProviderId: string;
      transcriptionStreamConfig: Json;
    },
  ): Promise<AutoSessionWindow> {
    const row = await db
      .insertInto('auto_session_windows')
      .values({
        room_uid: data.roomUid,
        local_start_time: data.localStartTime,
        local_end_time: data.localEndTime,
        days_of_week: data.daysOfWeek,
        transcription_provider_id: data.transcriptionProviderId,
        transcription_stream_config: data.transcriptionStreamConfig,
        active_end: data.activeEnd,
        active_start: data.activeStart,
      })
      .returning(WINDOW_COLUMNS)
      .executeTakeFirstOrThrow();
    return mapWindow(row);
  }

  /**
   * Sets `active_end` on a still-open auto-session window. No-op (returns
   * false) if the row is missing or already closed.
   * @param db Kysely client or transaction.
   * @param uid The window to close.
   * @param activeEnd The instant at which the window stops producing occurrences.
   * @returns `true` if a row was updated, `false` otherwise.
   */
  async updateWindowActiveEnd(
    db: DBOrTrx,
    uid: string,
    activeEnd: Date,
  ): Promise<boolean> {
    const result = await db
      .updateTable('auto_session_windows')
      .set({ active_end: activeEnd })
      .where('uid', '=', uid)
      .where('active_end', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  /**
   * Hard-deletes an auto-session window. AUTO sessions reference the window
   * only through reconciliation, so they are pruned by the next reconcile pass
   * rather than by FK cascade.
   * @param db Kysely client or transaction.
   * @param uid The window to delete.
   * @returns `true` if a row was deleted, `false` if the window did not exist.
   */
  async deleteWindowHard(db: DBOrTrx, uid: string): Promise<boolean> {
    const result = await db
      .deleteFrom('auto_session_windows')
      .where('uid', '=', uid)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  /**
   * Returns the session for `scheduleUid` whose effective interval covers `now`,
   * or whose effective end is the latest among already-realized sessions. Used
   * by `deleteSchedule` to compute where to close the schedule's active range.
   */
  async findLatestPastOrActiveSessionForSchedule(
    db: DBOrTrx,
    scheduleUid: string,
    now: Date,
  ): Promise<{ uid: string; effectiveEnd: Date | null } | undefined> {
    const effectiveStart = sql<Date>`COALESCE(start_override, scheduled_start_time)`;
    const effectiveEnd = sql<Date | null>`COALESCE(end_override, scheduled_end_time)`;

    const row = await db
      .selectFrom('sessions')
      .select(['uid', effectiveEnd.as('effective_end')])
      .where('scheduled_session_uid', '=', scheduleUid)
      .where(effectiveStart, '<=', now)
      .orderBy(effectiveStart, 'desc')
      .limit(1)
      .executeTakeFirst();

    if (!row) return undefined;
    return {
      uid: row.uid,
      effectiveEnd: row.effective_end,
    };
  }

  /**
   * Returns the room's currently-active session of any type, if any. Per the
   * single-active-session invariant, callers can rely on at most one row.
   * @param db Kysely client or transaction.
   * @param roomUid Room to scan.
   * @param now The instant against which "active" is evaluated.
   */
  async findActiveSession(
    db: DBOrTrx,
    roomUid: string,
    now: Date,
  ): Promise<Session | undefined> {
    return this._findActiveSessionOfType(db, roomUid, now, undefined);
  }

  /**
   * Returns the room's currently-active ON_DEMAND session, if any.
   * @param db Kysely client or transaction.
   * @param roomUid Room to scan.
   * @param now The instant against which "active" is evaluated.
   */
  async findActiveOnDemandSession(
    db: DBOrTrx,
    roomUid: string,
    now: Date,
  ): Promise<Session | undefined> {
    return this._findActiveSessionOfType(db, roomUid, now, 'ON_DEMAND');
  }

  /**
   * Returns the room's currently-active AUTO session, if any.
   * @param db Kysely client or transaction.
   * @param roomUid Room to scan.
   * @param now The instant against which "active" is evaluated.
   */
  async findActiveAutoSession(
    db: DBOrTrx,
    roomUid: string,
    now: Date,
  ): Promise<Session | undefined> {
    return this._findActiveSessionOfType(db, roomUid, now, 'AUTO');
  }

  /**
   * Returns AUTO sessions whose effective start is strictly after `now`,
   * ordered by effective start ascending. Used by the reconciler to delete
   * stale future AUTO rows before re-materializing.
   * @param db Kysely client or transaction.
   * @param roomUid Room to scan.
   * @param now Cutoff; only sessions starting strictly after this are returned.
   */
  async findUpcomingAutoSessions(
    db: DBOrTrx,
    roomUid: string,
    now: Date,
  ): Promise<Session[]> {
    const effectiveStart = sql<Date>`COALESCE(start_override, scheduled_start_time)`;
    const rows = await db
      .selectFrom('sessions')
      .select(SESSION_COLUMNS)
      .where('room_uid', '=', roomUid)
      .where('type', '=', 'AUTO')
      .where(effectiveStart, '>', now)
      .orderBy(effectiveStart, 'asc')
      .execute();
    return rows.map(mapSession);
  }

  /**
   * Returns SCHEDULED and ON_DEMAND sessions whose effective interval overlaps
   * `[range.from, range.to)`. Auto sessions are excluded — this is the input
   * the auto-session reconciler uses to figure out where the gaps are.
   */
  async findNonAutoSessionsInRange(
    db: DBOrTrx,
    roomUid: string,
    range: { from: Date; to: Date },
  ): Promise<Session[]> {
    const effectiveStart = sql<Date>`COALESCE(start_override, scheduled_start_time)`;
    const effectiveEnd = sql<Date | null>`COALESCE(end_override, scheduled_end_time)`;

    const rows = await db
      .selectFrom('sessions')
      .select(SESSION_COLUMNS)
      .where('room_uid', '=', roomUid)
      .where('type', 'in', ['SCHEDULED', 'ON_DEMAND'])
      .where(effectiveStart, '<', range.to)
      .where((eb) =>
        eb.or([
          eb(effectiveEnd, 'is', null),
          eb(effectiveEnd, '>', range.from),
        ]),
      )
      .orderBy(effectiveStart, 'asc')
      .execute();
    return rows.map(mapSession);
  }

  /**
   * Returns the effective start of the next SCHEDULED or ON_DEMAND session in
   * the room whose effective start is strictly after `after`, or `null` if
   * none. Used to compute an on-demand session's `scheduled_end_time` (both at
   * creation and when realigning around schedule changes). AUTO sessions are
   * excluded; they are reconciled separately and never bound an on-demand's
   * end.
   */
  async findNextNonAutoSessionStart(
    db: DBOrTrx,
    roomUid: string,
    after: Date,
  ): Promise<Date | null> {
    const effectiveStart = sql<Date>`COALESCE(start_override, scheduled_start_time)`;
    const row = await db
      .selectFrom('sessions')
      .select(effectiveStart.as('effective_start'))
      .where('room_uid', '=', roomUid)
      .where('type', 'in', ['SCHEDULED', 'ON_DEMAND'])
      .where(effectiveStart, '>', after)
      .orderBy(effectiveStart, 'asc')
      .limit(1)
      .executeTakeFirst();
    return row ? row.effective_start : null;
  }

  /**
   * Fetches a single session by UID.
   * @param db Kysely client or transaction.
   * @param uid The session's unique identifier.
   * @returns The mapped session, or `undefined` if not found.
   */
  async findSessionByUid(
    db: DBOrTrx,
    uid: string,
  ): Promise<Session | undefined> {
    const row = await db
      .selectFrom('sessions')
      .select(SESSION_COLUMNS)
      .where('uid', '=', uid)
      .executeTakeFirst();
    return row ? mapSession(row) : undefined;
  }

  /**
   * Returns the room's next upcoming session of any type (smallest
   * `effective_start > now`), or `undefined` if none. Used to validate the
   * "target is the next upcoming" precondition for `start-session-early`.
   */
  async findNextUpcomingSession(
    db: DBOrTrx,
    roomUid: string,
    now: Date,
  ): Promise<Session | undefined> {
    const effectiveStart = sql<Date>`COALESCE(start_override, scheduled_start_time)`;
    const row = await db
      .selectFrom('sessions')
      .select(SESSION_COLUMNS)
      .where('room_uid', '=', roomUid)
      .where(effectiveStart, '>', now)
      .orderBy(effectiveStart, 'asc')
      .limit(1)
      .executeTakeFirst();
    return row ? mapSession(row) : undefined;
  }

  /**
   * All sessions in the room whose effective interval overlaps `[range.from, range.to)`.
   * Ordered by effective start ascending.
   */
  async listSessionsForRoomInRange(
    db: DBOrTrx,
    roomUid: string,
    range: { from: Date; to: Date },
  ): Promise<Session[]> {
    const effectiveStart = sql<Date>`COALESCE(start_override, scheduled_start_time)`;
    const effectiveEnd = sql<Date | null>`COALESCE(end_override, scheduled_end_time)`;

    const rows = await db
      .selectFrom('sessions')
      .select(SESSION_COLUMNS)
      .where('room_uid', '=', roomUid)
      .where(effectiveStart, '<', range.to)
      .where((eb) =>
        eb.or([
          eb(effectiveEnd, 'is', null),
          eb(effectiveEnd, '>', range.from),
        ]),
      )
      .orderBy(effectiveStart, 'asc')
      .execute();
    return rows.map(mapSession);
  }

  /**
   * The currently-active session (effective_start ≤ now AND (effective_end > now
   * OR null)) followed by upcoming sessions whose effective start is in
   * `(now, upTo]`. Returned as a flat list ordered by effective start; the
   * service splits the at-most-one active row from the upcoming tail.
   */
  async listActiveAndUpcomingSessions(
    db: DBOrTrx,
    roomUid: string,
    now: Date,
    upTo: Date,
  ): Promise<Session[]> {
    const effectiveStart = sql<Date>`COALESCE(start_override, scheduled_start_time)`;
    const effectiveEnd = sql<Date | null>`COALESCE(end_override, scheduled_end_time)`;

    const rows = await db
      .selectFrom('sessions')
      .select(SESSION_COLUMNS)
      .where('room_uid', '=', roomUid)
      .where((eb) =>
        eb.or([
          // active
          eb.and([
            eb(effectiveStart, '<=', now),
            eb.or([eb(effectiveEnd, 'is', null), eb(effectiveEnd, '>', now)]),
          ]),
          // upcoming up to horizon
          eb.and([
            eb(effectiveStart, '>', now),
            eb(effectiveStart, '<=', upTo),
          ]),
        ]),
      )
      .orderBy(effectiveStart, 'asc')
      .execute();
    return rows.map(mapSession);
  }

  /**
   * Bulk-inserts `sessions` rows. No-op when `rows` is empty.
   * @param db Kysely client or transaction.
   * @param rows Rows to insert.
   * @returns The newly created sessions in insertion order.
   */
  async insertSessions(db: DBOrTrx, rows: SessionInsert[]): Promise<Session[]> {
    if (rows.length === 0) return [];
    const inserted = await db
      .insertInto('sessions')
      .values(
        rows.map((r) => ({
          room_uid: r.roomUid,
          name: r.name,
          type: r.type,
          scheduled_session_uid: r.scheduledSessionUid,
          scheduled_start_time: r.scheduledStartTime,
          scheduled_end_time: r.scheduledEndTime,
          join_code_scopes: r.joinCodeScopes,
          transcription_provider_id: r.transcriptionProviderId,
          transcription_stream_config: r.transcriptionStreamConfig,
        })),
      )
      .returning(SESSION_COLUMNS)
      .execute();
    return inserted.map(mapSession);
  }

  /**
   * Updates `scheduled_end_time` and bumps `session_config_version`.
   * @returns The new `session_config_version`.
   */
  async updateSessionScheduledEnd(
    db: DBOrTrx,
    uid: string,
    scheduledEndTime: Date | null,
  ): Promise<number> {
    const row = await db
      .updateTable('sessions')
      .set({
        scheduled_end_time: scheduledEndTime,
        session_config_version: sql<string>`session_config_version + 1`,
      })
      .where('uid', '=', uid)
      .returning('session_config_version')
      .executeTakeFirstOrThrow();
    return Number(row.session_config_version);
  }

  /**
   * Sets `start_override` and bumps `session_config_version`.
   * @returns The new `session_config_version`.
   */
  async updateSessionStartOverride(
    db: DBOrTrx,
    uid: string,
    startOverride: Date,
  ): Promise<number> {
    const row = await db
      .updateTable('sessions')
      .set({
        start_override: startOverride,
        session_config_version: sql<string>`session_config_version + 1`,
      })
      .where('uid', '=', uid)
      .returning('session_config_version')
      .executeTakeFirstOrThrow();
    return Number(row.session_config_version);
  }

  /**
   * Sets `end_override` and bumps `session_config_version`.
   * @returns The new `session_config_version`.
   */
  async updateSessionEndOverride(
    db: DBOrTrx,
    uid: string,
    endOverride: Date,
  ): Promise<number> {
    const row = await db
      .updateTable('sessions')
      .set({
        end_override: endOverride,
        session_config_version: sql<string>`session_config_version + 1`,
      })
      .where('uid', '=', uid)
      .returning('session_config_version')
      .executeTakeFirstOrThrow();
    return Number(row.session_config_version);
  }

  /**
   * Deletes future SCHEDULED sessions in the room (effective_start > now).
   * Used by `updateRoomScheduleConfig` on a timezone change: future sessions
   * computed under the old timezone are discarded so they can be re-expanded
   * under the new one. Past and currently-active SCHEDULED sessions survive.
   */
  async deleteUpcomingScheduledSessions(
    db: DBOrTrx,
    roomUid: string,
    now: Date,
  ): Promise<void> {
    const effectiveStart = sql<Date>`COALESCE(start_override, scheduled_start_time)`;
    await db
      .deleteFrom('sessions')
      .where('room_uid', '=', roomUid)
      .where('type', '=', 'SCHEDULED')
      .where(effectiveStart, '>', now)
      .execute();
  }

  /**
   * Returns schedules in the room whose active range still produces
   * occurrences after `now` (`active_end IS NULL OR active_end > now`).
   * Ordered by `active_start` ascending. Used by `updateRoomScheduleConfig`
   * to re-expand SCHEDULED sessions under a new timezone.
   */
  async listOpenSchedulesForRoom(
    db: DBOrTrx,
    roomUid: string,
    now: Date,
  ): Promise<Schedule[]> {
    const rows = await db
      .selectFrom('session_schedules')
      .select(SCHEDULE_COLUMNS)
      .where('room_uid', '=', roomUid)
      .where((eb) =>
        eb.or([eb('active_end', 'is', null), eb('active_end', '>', now)]),
      )
      .orderBy('active_start', 'asc')
      .execute();
    return rows.map((r) => mapSchedule(r as ScheduleRow));
  }

  /** Deletes future (effective_start > now) sessions for a schedule. */
  async deleteUpcomingSessionsForSchedule(
    db: DBOrTrx,
    scheduleUid: string,
    now: Date,
  ): Promise<void> {
    const effectiveStart = sql<Date>`COALESCE(start_override, scheduled_start_time)`;
    await db
      .deleteFrom('sessions')
      .where('scheduled_session_uid', '=', scheduleUid)
      .where(effectiveStart, '>', now)
      .execute();
  }

  /** Deletes future AUTO sessions in the room. */
  async deleteUpcomingAutoSessions(
    db: DBOrTrx,
    roomUid: string,
    now: Date,
  ): Promise<void> {
    const effectiveStart = sql<Date>`COALESCE(start_override, scheduled_start_time)`;
    await db
      .deleteFrom('sessions')
      .where('room_uid', '=', roomUid)
      .where('type', '=', 'AUTO')
      .where(effectiveStart, '>', now)
      .execute();
  }

  /**
   * Defers the `sessions_no_overlap` exclusion constraint to commit-time, so
   * the reconciler can swap auto sessions out and back in without tripping the
   * constraint mid-transaction. Must run inside a transaction.
   */
  async setSessionsConstraintsDeferred(db: DBOrTrx): Promise<void> {
    await sql`SET CONSTRAINTS sessions_no_overlap DEFERRED`.execute(db);
  }

  /**
   * Returns the session whose effective interval covers `now`. When `type` is
   * provided, restricts to that session type; otherwise returns the active
   * session regardless of type. Backs `findActiveSession`,
   * `findActiveOnDemandSession`, and `findActiveAutoSession`.
   */
  private async _findActiveSessionOfType(
    db: DBOrTrx,
    roomUid: string,
    now: Date,
    type: SessionType | undefined,
  ): Promise<Session | undefined> {
    const effectiveStart = sql<Date>`COALESCE(start_override, scheduled_start_time)`;
    const effectiveEnd = sql<Date | null>`COALESCE(end_override, scheduled_end_time)`;

    let q = db
      .selectFrom('sessions')
      .select(SESSION_COLUMNS)
      .where('room_uid', '=', roomUid)
      .where(effectiveStart, '<=', now)
      .where((eb) =>
        eb.or([eb(effectiveEnd, 'is', null), eb(effectiveEnd, '>', now)]),
      );
    if (type !== undefined) {
      q = q.where('type', '=', type);
    }
    const row = await q.executeTakeFirst();
    return row ? mapSession(row) : undefined;
  }
}
