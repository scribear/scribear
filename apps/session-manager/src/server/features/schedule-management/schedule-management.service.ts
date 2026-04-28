import type { Transaction } from 'kysely';

import type {
  DB,
  DayOfWeek,
  Json,
  ScheduleFrequency,
  SessionScope,
} from '@scribear/scribear-db';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import type {
  AutoSessionWindow,
  Schedule,
  Session,
} from '#src/server/features/schedule-management/schedule-management.repository.js';
import {
  RoomScheduleVersionBumpedChannel,
  SessionConfigVersionBumpedChannel,
} from '#src/server/shared/events/schedule-management.events.js';

import { reconcileAutoSessions } from './utils/auto-session-reconciler.js';
import { detectConflict } from './utils/conflict-detector.js';
import { buildScheduledSessionRow } from './utils/occurrence-to-session.js';
import { materializeSchedule } from './utils/schedule-materializer.js';
import type { ScheduleForMaterialization } from './utils/schedule-materializer.js';
import { materializeWindow } from './utils/window-materializer.js';

/**
 * Mutable accumulator threaded through every service mutation. Helpers
 * (`reconcileAutoSessions`, `_realignActiveOnDemandSession`,
 * `_finalizeRoomWrite`) record version bumps here; the top-level service
 * method publishes the corresponding events on the event bus after the
 * transaction commits, so subscribers never observe uncommitted state.
 */
interface EventCollector {
  // Map of session uid -> its new `session_config_version`.
  sessionBumps: Map<string, number>;
  // Set when `_finalizeRoomWrite` runs; otherwise `null`.
  roomBump: { roomUid: string; roomScheduleVersion: number } | null;
}

function newEventCollector(): EventCollector {
  return { sessionBumps: new Map(), roomBump: null };
}

/**
 * Thrown by `materializeOneStaleRoom` when the underlying transaction failed
 * after a room was selected and locked. Carries the locked room's UID so the
 * worker can add it to its skip set and continue draining.
 */
export class MaterializationFailedError extends Error {
  public readonly roomUid: string;
  public readonly innerError: unknown;

  constructor(roomUid: string, innerError: unknown) {
    const innerMsg =
      innerError instanceof Error ? innerError.message : String(innerError);
    super(`Materialization failed for room ${roomUid}: ${innerMsg}`);
    this.name = 'MaterializationFailedError';
    this.roomUid = roomUid;
    this.innerError = innerError;
  }
}

const MATERIALIZATION_WINDOW_DAYS = 7;
const MIN_AUTO_SESSION_DURATION_SECONDS = 60;
const CONFLICT_CHECK_HORIZON_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

/** Fields accepted by `createSchedule`. */
interface CreateScheduleInput {
  roomUid: string;
  name: string;
  activeStart: Date;
  /** When set, the schedule produces no occurrences at or after this instant. */
  activeEnd: Date | null;
  localStartTime: string;
  localEndTime: string;
  frequency: ScheduleFrequency;
  daysOfWeek: DayOfWeek[] | null;
  joinCodeScopes: SessionScope[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: Json;
}

/**
 * Fields accepted by `updateSchedule`. Any omitted field is left at its
 * existing value; explicit `null` clears optional nullable fields.
 */
interface UpdateScheduleInput {
  name?: string;
  activeStart?: Date;
  activeEnd?: Date | null;
  localStartTime?: string;
  localEndTime?: string;
  frequency?: ScheduleFrequency;
  daysOfWeek?: DayOfWeek[] | null;
  joinCodeScopes?: SessionScope[];
  transcriptionProviderId?: string;
  transcriptionStreamConfig?: Json;
}

/** Fields accepted by `createAutoSessionWindow`. */
interface CreateWindowInput {
  roomUid: string;
  localStartTime: string;
  localEndTime: string;
  daysOfWeek: DayOfWeek[];
  activeStart: Date;
  activeEnd: Date | null;
  transcriptionProviderId: string;
  transcriptionStreamConfig: Json;
}

/**
 * Fields accepted by `updateRoomScheduleConfig`. Only `autoSessionEnabled` is
 * mutable post-creation; room timezone is immutable. When `autoSessionEnabled`
 * is omitted or equals the current value, the call is a no-op (no writes,
 * no version bump, no event).
 */
interface UpdateRoomScheduleConfigInput {
  autoSessionEnabled?: boolean;
}

/** Fields accepted by `createOnDemandSession`. */
interface CreateOnDemandSessionInput {
  roomUid: string;
  name: string;
  joinCodeScopes: SessionScope[];
  transcriptionProviderId: string;
  transcriptionStreamConfig: Json;
}

/**
 * Fields accepted by `updateAutoSessionWindow`. Any omitted field is left at
 * its existing value; explicit `null` clears optional nullable fields.
 */
interface UpdateWindowInput {
  localStartTime?: string;
  localEndTime?: string;
  daysOfWeek?: DayOfWeek[];
  activeStart?: Date;
  activeEnd?: Date | null;
  transcriptionProviderId?: string;
  transcriptionStreamConfig?: Json;
}

/**
 * Projects a `Schedule` (or candidate) onto the subset of fields needed by
 * `materializeSchedule` and `detectConflict`.
 */
function scheduleToMaterializationRecord(
  s: Pick<
    Schedule,
    | 'uid'
    | 'activeStart'
    | 'activeEnd'
    | 'anchorStart'
    | 'localStartTime'
    | 'localEndTime'
    | 'frequency'
    | 'daysOfWeek'
  >,
): ScheduleForMaterialization {
  return {
    uid: s.uid,
    activeStart: s.activeStart,
    activeEnd: s.activeEnd,
    anchorStart: s.anchorStart,
    localStartTime: s.localStartTime,
    localEndTime: s.localEndTime,
    frequency: s.frequency,
    daysOfWeek: s.daysOfWeek,
  };
}

/**
 * Thrown inside a `_runWithEvents` transaction callback to force a rollback
 * while still returning a typed result code to the caller. Kysely commits on
 * normal return and rolls back on throw; this sentinel bridges the gap for
 * mutation helpers that must abort mid-transaction on validation errors.
 */
class RollbackError extends Error {
  constructor(readonly result: unknown) {
    super('transaction aborted');
  }
}

/**
 * Orchestrates schedule and auto-session-window CRUD inside a single
 * transaction per operation. Each method:
 *  - Locks the room row.
 *  - Reads overlapping schedules / windows; runs conflict / overlap checks.
 *  - Writes the schedule or window row.
 *  - Materializes new SCHEDULED sessions (within the materialization window).
 *  - Reconciles auto sessions to satisfy the post-condition in the spec.
 *  - Realigns any active on-demand session whose `scheduled_end_time` may
 *    have been pinned to the start of a session that no longer exists.
 *  - Bumps `room_schedule_version` and `last_materialized_at`.
 */
export class ScheduleManagementService {
  private _log: AppDependencies['logger'];
  private _dbClient: AppDependencies['dbClient'];
  private _repo: AppDependencies['scheduleManagementRepository'];
  private _eventBus: AppDependencies['eventBusService'];

  constructor(
    logger: AppDependencies['logger'],
    dbClient: AppDependencies['dbClient'],
    scheduleManagementRepository: AppDependencies['scheduleManagementRepository'],
    eventBusService: AppDependencies['eventBusService'],
  ) {
    this._log = logger;
    this._dbClient = dbClient;
    this._repo = scheduleManagementRepository;
    this._eventBus = eventBusService;
  }

  /**
   * Runs `fn` inside a single database transaction and, on successful commit,
   * publishes the version-bump events the helpers recorded in the collector.
   * Events are never fired for rolled-back transactions (the throw skips the
   * publish), so subscribers only see committed state.
   */
  private async _runWithEvents<R>(
    fn: (trx: Transaction<DB>, collector: EventCollector) => Promise<R>,
  ): Promise<R> {
    const collector = newEventCollector();
    try {
      const result = await this._dbClient.db
        .transaction()
        .execute((trx) => fn(trx, collector));
      this._publishEvents(collector);
      return result;
    } catch (e) {
      if (e instanceof RollbackError) return e.result as R;
      throw e;
    }
  }

  /** Fan out the collector's accumulated bumps onto the in-process event bus. */
  private _publishEvents(collector: EventCollector): void {
    for (const [sessionUid, sessionConfigVersion] of collector.sessionBumps) {
      this._eventBus.publish(
        SessionConfigVersionBumpedChannel,
        { sessionUid, sessionConfigVersion },
        sessionUid,
      );
    }
    if (collector.roomBump !== null) {
      const { roomUid, roomScheduleVersion } = collector.roomBump;
      this._eventBus.publish(
        RoomScheduleVersionBumpedChannel,
        { roomUid, roomScheduleVersion },
        roomUid,
      );
    }
  }

  /**
   * Toggles the room's `autoSessionEnabled` master switch and reconciles
   * AUTO sessions atomically. When the new value matches the existing row,
   * the call is a no-op (no writes, no version bump, no event). Room
   * `timezone` is immutable and cannot be updated through this method.
   * @param uid The room to update.
   * @param data Fields to update.
   * @param now Reference instant for reconciliation.
   * @returns `undefined` on success, or `'ROOM_NOT_FOUND'` if the room is missing.
   */
  async updateRoomScheduleConfig(
    uid: string,
    data: UpdateRoomScheduleConfigInput,
    now: Date,
  ): Promise<undefined | 'ROOM_NOT_FOUND'> {
    return this._runWithEvents(async (trx, collector) => {
      const room = await this._repo.lockRoom(trx, uid);
      if (!room) return 'ROOM_NOT_FOUND' as const;

      const newAutoEnabled = data.autoSessionEnabled ?? room.autoSessionEnabled;
      if (newAutoEnabled === room.autoSessionEnabled) {
        return undefined;
      }

      await this._repo.updateRoomScheduleConfig(trx, uid, {
        autoSessionEnabled: newAutoEnabled,
      });

      const windowEnd = addDays(now, MATERIALIZATION_WINDOW_DAYS);

      await reconcileAutoSessions(
        trx,
        this._repo,
        uid,
        room.timezone,
        now,
        windowEnd,
        MIN_AUTO_SESSION_DURATION_SECONDS,
        newAutoEnabled,
        collector.sessionBumps,
      );

      await this._realignActiveOnDemandSession(trx, uid, now, collector);

      await this._finalizeRoomWrite(trx, uid, now, collector);
      return undefined;
    });
  }

  /**
   * Picks one stale room (`last_materialized_at` null or older than `cutoff`),
   * locks it via `FOR UPDATE SKIP LOCKED`, and extends its materialization
   * horizon to `now + MATERIALIZATION_WINDOW_DAYS`. Used by the periodic
   * materialization worker; safe to invoke from multiple processes in
   * parallel because each call grabs a distinct unlocked row.
   *
   * On per-room materialization failure the underlying error is rethrown
   * wrapped in `MaterializationFailedError` so the worker can record the
   * failed UID in its skip set and move on to the next room.
   * @param now Reference instant for materialization.
   * @param cutoff Rooms last materialized at or before this instant are eligible.
   * @param excludeUids Room UIDs to exclude from selection (used by the worker to skip rooms whose materialization failed earlier in the same drain pass).
   * @returns The processed room's UID, or `null` if no eligible rooms remain.
   */
  async materializeOneStaleRoom(
    now: Date,
    cutoff: Date,
    excludeUids?: readonly string[],
  ): Promise<string | null> {
    // Use a mutable cell so TS narrowing in the catch block doesn't conclude
    // the lambda's assignment is unobservable.
    const lockedRef: { uid: string | null } = { uid: null };
    try {
      return await this._runWithEvents(async (trx, collector) => {
        const room = await this._repo.findOneStaleRoomForMaterialization(
          trx,
          cutoff,
          excludeUids,
        );
        if (!room) return null;
        lockedRef.uid = room.uid;
        await this._doMaterializeRoom(trx, room, now, collector);
        return room.uid;
      });
    } catch (err) {
      if (lockedRef.uid !== null) {
        throw new MaterializationFailedError(lockedRef.uid, err);
      }
      throw err;
    }
  }

  /**
   * Extends the materialization horizon for a single locked room. For each
   * open schedule, materializes occurrences in the gap between the latest
   * existing SCHEDULED session and `now + 7 days`, avoiding duplicates by
   * starting after the existing max. The auto-session reconciler then handles
   * AUTO sessions over the same window. Finally bumps the room version and
   * stamps `last_materialized_at`.
   *
   * Assumes the caller already holds a `FOR UPDATE` lock on the room row.
   */
  private async _doMaterializeRoom(
    trx: Transaction<DB>,
    room: { uid: string; timezone: string; autoSessionEnabled: boolean },
    now: Date,
    collector: EventCollector,
  ): Promise<void> {
    const windowEnd = addDays(now, MATERIALIZATION_WINDOW_DAYS);

    const schedules = await this._repo.listOpenSchedulesForRoom(
      trx,
      room.uid,
      now,
    );

    const inserts: ReturnType<typeof buildScheduledSessionRow>[] = [];
    for (const schedule of schedules) {
      const maxEnd = await this._repo.findMaxScheduledEndForSchedule(
        trx,
        schedule.uid,
      );
      // Start materialization just past the last existing occurrence's end.
      // The materializer's range predicate (`occ.endUtc <= windowStart`
      // excludes the occurrence) means passing `maxEnd` as windowStart
      // correctly skips the existing latest session without slicing into it.
      // Fall back to `now` / `schedule.activeStart` when nothing has been
      // materialized yet.
      const from = maxEnd
        ? maxDate(maxEnd, schedule.activeStart)
        : maxDate(now, schedule.activeStart);
      if (from.getTime() >= windowEnd.getTime()) continue;

      const occurrences = materializeSchedule(
        scheduleToMaterializationRecord(schedule),
        room.timezone,
        from,
        windowEnd,
      );
      for (const occ of occurrences) {
        inserts.push(buildScheduledSessionRow(schedule, occ));
      }
    }

    if (inserts.length > 0) {
      await this._repo.setSessionsConstraintsDeferred(trx);
      await this._repo.insertSessions(trx, inserts);
    }

    await reconcileAutoSessions(
      trx,
      this._repo,
      room.uid,
      room.timezone,
      now,
      windowEnd,
      MIN_AUTO_SESSION_DURATION_SECONDS,
      room.autoSessionEnabled,
      collector.sessionBumps,
    );

    await this._realignActiveOnDemandSession(trx, room.uid, now, collector);
    await this._finalizeRoomWrite(trx, room.uid, now, collector);
  }

  /**
   * Creates a new schedule, materializes its occurrences within the
   * materialization window, and reconciles AUTO sessions in the room.
   * @param data Fields for the new schedule.
   * @param now The reference instant for materialization and conflict checks.
   * @returns The created schedule, `'ROOM_NOT_FOUND'` if the room does not exist, or `'CONFLICT'` if the schedule overlaps an existing one.
   */
  async createSchedule(
    data: CreateScheduleInput,
    now: Date,
  ): Promise<
    | Schedule
    | 'ROOM_NOT_FOUND'
    | 'CONFLICT'
    | 'INVALID_ACTIVE_START'
    | 'INVALID_ACTIVE_END'
    | 'INVALID_LOCAL_TIMES'
    | 'INVALID_FREQUENCY_FIELDS'
  > {
    return this._runWithEvents(async (trx, collector) => {
      const room = await this._repo.lockRoom(trx, data.roomUid);
      if (!room) return 'ROOM_NOT_FOUND' as const;

      // For brand-new schedules the anchor equals the activeStart.
      const result = await this._doCreateSchedule(
        trx,
        data,
        data.activeStart,
        room,
        now,
        collector,
      );
      if (result === 'CONFLICT' || result === 'INVALID_ACTIVE_START') {
        return result;
      }

      await this._finalizeRoomWrite(trx, data.roomUid, now, collector);
      return result;
    });
  }

  /**
   * Lists schedules for a room, optionally filtered by a time range.
   * Returns schedules whose active range overlaps `[from, to]` (both bounds
   * are optional; omitting them returns all schedules for the room).
   * @param roomUid Room to query.
   * @param range Optional `from`/`to` bounds.
   * @returns The matching schedules, or `'ROOM_NOT_FOUND'` if the room does not exist.
   */
  async listSchedulesForRoom(
    roomUid: string,
    range: { from?: Date; to?: Date },
  ): Promise<Schedule[] | 'ROOM_NOT_FOUND'> {
    const exists = await this._repo.roomExists(this._repo.db, roomUid);
    if (!exists) return 'ROOM_NOT_FOUND' as const;
    return this._repo.listSchedulesForRoom(this._repo.db, roomUid, range);
  }

  /**
   * Fetches a single schedule by UID.
   * @param uid The schedule's unique identifier.
   * @returns The schedule, or `'NOT_FOUND'` if no matching schedule exists.
   */
  async findScheduleByUid(uid: string): Promise<Schedule | 'NOT_FOUND'> {
    const schedule = await this._repo.findScheduleByUid(this._repo.db, uid);
    return schedule ?? ('NOT_FOUND' as const);
  }

  /**
   * Closes (or hard-deletes) a schedule, prunes its upcoming SCHEDULED
   * sessions, and reconciles AUTO sessions in the room.
   * @param uid The schedule to delete.
   * @param now The reference instant. Schedules whose `activeStart > now` are hard-deleted; otherwise `active_end` is closed at the schedule's last realized session end.
   * @returns `undefined` on success, or `'NOT_FOUND'` if the schedule is missing or already closed.
   */
  async deleteSchedule(
    uid: string,
    now: Date,
  ): Promise<undefined | 'NOT_FOUND'> {
    return this._runWithEvents(async (trx, collector) => {
      const result = await this._doDeleteSchedule(trx, uid, now, collector);
      if (result === 'NOT_FOUND') return 'NOT_FOUND' as const;

      await this._finalizeRoomWrite(trx, result.roomUid, now, collector);
      return undefined;
    });
  }

  /**
   * Updates an open schedule by closing the existing row at `now` and
   * inserting a new schedule with the merged fields. Existing SCHEDULED
   * sessions before `now` are preserved; future occurrences are re-materialized
   * from the merged row.
   * @param uid The schedule to update; must be open (`active_end` is null).
   * @param data Fields to update; omitted fields fall back to the existing row.
   * @param now The reference instant for the close-and-reinsert pivot.
   * @returns The new schedule, `'NOT_FOUND'` if the row is missing or already closed, or `'CONFLICT'` if the merged schedule overlaps another.
   */
  async updateSchedule(
    uid: string,
    data: UpdateScheduleInput,
    now: Date,
  ): Promise<
    | Schedule
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'INVALID_ACTIVE_START'
    | 'INVALID_ACTIVE_END'
    | 'INVALID_LOCAL_TIMES'
    | 'INVALID_FREQUENCY_FIELDS'
  > {
    return this._runWithEvents(async (trx, collector) => {
      const existing = await this._repo.findScheduleByUid(trx, uid);
      if (existing?.activeEnd !== null) {
        return 'NOT_FOUND' as const;
      }

      const room = await this._repo.lockRoom(trx, existing.roomUid);
      if (!room) return 'NOT_FOUND' as const;

      const deleted = await this._doDeleteSchedule(trx, uid, now, collector);
      if (deleted === 'NOT_FOUND') return 'NOT_FOUND' as const;

      // Merged active_start defaults to the existing row's; the caller must
      // supply an explicit future value to update a schedule that has already
      // taken effect (existing.activeStart <= now). _doCreateSchedule rejects
      // any merged.activeStart <= now with INVALID_ACTIVE_START.
      const merged: CreateScheduleInput = {
        roomUid: existing.roomUid,
        name: data.name ?? existing.name,
        activeStart: data.activeStart ?? existing.activeStart,
        activeEnd:
          'activeEnd' in data ? (data.activeEnd ?? null) : existing.activeEnd,
        localStartTime: data.localStartTime ?? existing.localStartTime,
        localEndTime: data.localEndTime ?? existing.localEndTime,
        frequency: data.frequency ?? existing.frequency,
        daysOfWeek:
          'daysOfWeek' in data
            ? (data.daysOfWeek ?? null)
            : existing.daysOfWeek,
        joinCodeScopes: data.joinCodeScopes ?? existing.joinCodeScopes,
        transcriptionProviderId:
          data.transcriptionProviderId ?? existing.transcriptionProviderId,
        transcriptionStreamConfig:
          data.transcriptionStreamConfig ?? existing.transcriptionStreamConfig,
      };

      // Anchor is preserved verbatim across updates so BIWEEKLY cadence does
      // not shift even when activeStart is bumped forward by the merge.
      const created = await this._doCreateSchedule(
        trx,
        merged,
        existing.anchorStart,
        room,
        now,
        collector,
      );
      if (typeof created === 'string') {
        throw new RollbackError(created);
      }

      await this._finalizeRoomWrite(trx, existing.roomUid, now, collector);
      return created;
    });
  }

  /**
   * Creates a new auto-session window and reconciles AUTO sessions in the room.
   * @param data Fields for the new window.
   * @param now The reference instant for materialization and overlap checks.
   * @returns The created window, `'ROOM_NOT_FOUND'` if the room does not exist, or `'CONFLICT'` if the window overlaps an existing one.
   */
  async createAutoSessionWindow(
    data: CreateWindowInput,
    now: Date,
  ): Promise<
    AutoSessionWindow | 'ROOM_NOT_FOUND' | 'CONFLICT' | 'INVALID_ACTIVE_END'
  > {
    return this._runWithEvents(async (trx, collector) => {
      const room = await this._repo.lockRoom(trx, data.roomUid);
      if (!room) return 'ROOM_NOT_FOUND' as const;

      const result = await this._doCreateWindow(
        trx,
        data,
        room,
        now,
        collector,
      );
      if (typeof result === 'string') return result;

      await this._finalizeRoomWrite(trx, data.roomUid, now, collector);
      return result;
    });
  }

  /**
   * Fetches a single auto-session window by UID.
   * @param uid The window's unique identifier.
   * @returns The window, or `'NOT_FOUND'` if no matching window exists.
   */
  async findAutoSessionWindowByUid(
    uid: string,
  ): Promise<AutoSessionWindow | 'NOT_FOUND'> {
    const window = await this._repo.findWindowByUid(this._repo.db, uid);
    return window ?? ('NOT_FOUND' as const);
  }

  /**
   * Lists auto-session windows for a room, optionally filtered by a time
   * range. Returns windows whose active range overlaps `[from, to]` (both
   * bounds are optional; omitting them returns all windows for the room).
   * @param roomUid Room to query.
   * @param range Optional `from`/`to` bounds.
   * @returns The matching windows, or `'ROOM_NOT_FOUND'` if the room does not exist.
   */
  async listAutoSessionWindowsForRoom(
    roomUid: string,
    range: { from?: Date; to?: Date },
  ): Promise<AutoSessionWindow[] | 'ROOM_NOT_FOUND'> {
    const exists = await this._repo.roomExists(this._repo.db, roomUid);
    if (!exists) return 'ROOM_NOT_FOUND' as const;
    return this._repo.listWindowsForRoom(this._repo.db, roomUid, range);
  }

  /**
   * Closes (or hard-deletes) an auto-session window and reconciles AUTO
   * sessions in the room.
   * @param uid The window to delete.
   * @param now The reference instant. Windows whose `activeStart > now` are hard-deleted; otherwise `active_end` is closed at `max(now, activeStart + 1ms)`.
   * @returns `undefined` on success, or `'NOT_FOUND'` if the window is missing or already closed.
   */
  async deleteAutoSessionWindow(
    uid: string,
    now: Date,
  ): Promise<undefined | 'NOT_FOUND'> {
    return this._runWithEvents(async (trx, collector) => {
      const result = await this._doDeleteWindow(trx, uid, now, collector);
      if (result === 'NOT_FOUND') return 'NOT_FOUND' as const;

      await this._finalizeRoomWrite(trx, result.roomUid, now, collector);
      return undefined;
    });
  }

  /**
   * Updates an open auto-session window by closing the existing row at `now`
   * and inserting a new window with the merged fields.
   * @param uid The window to update; must be open (`active_end` is null).
   * @param data Fields to update; omitted fields fall back to the existing row.
   * @param now The reference instant for the close-and-reinsert pivot.
   * @returns The new window, `'NOT_FOUND'` if the row is missing or already closed, or `'CONFLICT'` if the merged window overlaps another.
   */
  async updateAutoSessionWindow(
    uid: string,
    data: UpdateWindowInput,
    now: Date,
  ): Promise<
    AutoSessionWindow | 'NOT_FOUND' | 'CONFLICT' | 'INVALID_ACTIVE_END'
  > {
    return this._runWithEvents(async (trx, collector) => {
      const existing = await this._repo.findWindowByUid(trx, uid);
      if (existing?.activeEnd !== null) {
        return 'NOT_FOUND' as const;
      }

      const room = await this._repo.lockRoom(trx, existing.roomUid);
      if (!room) return 'NOT_FOUND' as const;

      // Skip the inner reconciles: the intermediate "no window" state would
      // wrongly end the active AUTO before the new window is inserted. We run
      // a single reconcile after both delete and create complete.
      const deleted = await this._doDeleteWindow(trx, uid, now, collector, {
        skipReconcile: true,
      });
      if (deleted === 'NOT_FOUND') return 'NOT_FOUND' as const;

      // Preserve the existing activeStart on merge (don't bump to `now`).
      // Bumping would push the materializer's inRange check past today's
      // already-running occurrence, so the new window wouldn't cover it
      // and the active AUTO would be ended instead of preserved.
      const merged: CreateWindowInput = {
        roomUid: existing.roomUid,
        localStartTime: data.localStartTime ?? existing.localStartTime,
        localEndTime: data.localEndTime ?? existing.localEndTime,
        daysOfWeek: data.daysOfWeek ?? existing.daysOfWeek,
        activeStart: data.activeStart ?? existing.activeStart,
        activeEnd:
          'activeEnd' in data ? (data.activeEnd ?? null) : existing.activeEnd,
        transcriptionProviderId:
          data.transcriptionProviderId ?? existing.transcriptionProviderId,
        transcriptionStreamConfig:
          data.transcriptionStreamConfig ?? existing.transcriptionStreamConfig,
      };

      const created = await this._doCreateWindow(
        trx,
        merged,
        room,
        now,
        collector,
        { skipReconcile: true },
      );
      if (typeof created === 'string') throw new RollbackError(created);

      const windowEnd = addDays(now, MATERIALIZATION_WINDOW_DAYS);
      await reconcileAutoSessions(
        trx,
        this._repo,
        existing.roomUid,
        room.timezone,
        now,
        windowEnd,
        MIN_AUTO_SESSION_DURATION_SECONDS,
        room.autoSessionEnabled,
        collector.sessionBumps,
      );

      await this._finalizeRoomWrite(trx, existing.roomUid, now, collector);
      return created;
    });
  }

  /**
   * Fetches a single session by UID.
   * @param uid The session's unique identifier.
   * @returns The session, or `'NOT_FOUND'` if no matching session exists.
   */
  async getSession(uid: string): Promise<Session | 'NOT_FOUND'> {
    const session = await this._repo.findSessionByUid(this._repo.db, uid);
    return session ?? ('NOT_FOUND' as const);
  }

  /**
   * Lists sessions in the room whose effective interval overlaps
   * `[range.from, range.to)`, ordered by effective start ascending.
   * @param roomUid The room to query.
   * @param range Time range to test for overlap.
   */
  async listSessionsForRoomInRange(
    roomUid: string,
    range: { from: Date; to: Date },
  ): Promise<Session[]> {
    return this._repo.listSessionsForRoomInRange(this._repo.db, roomUid, range);
  }

  /**
   * Splits the at-most-one currently-active session from upcoming sessions
   * whose effective start lies in `(now, upTo]`.
   * @param roomUid The room to query.
   * @param now Instant against which "active" is evaluated.
   * @param upTo Upper bound (inclusive) for upcoming sessions.
   * @returns `{ active, upcoming }` where `active` is the at-most-one in-progress session.
   */
  async listActiveAndUpcomingSessions(
    roomUid: string,
    now: Date,
    upTo: Date,
  ): Promise<{ active: Session | null; upcoming: Session[] }> {
    const rows = await this._repo.listActiveAndUpcomingSessions(
      this._repo.db,
      roomUid,
      now,
      upTo,
    );
    let active: Session | null = null;
    const upcoming: Session[] = [];
    for (const r of rows) {
      const isActive =
        r.effectiveStart.getTime() <= now.getTime() &&
        (r.effectiveEnd === null || r.effectiveEnd.getTime() > now.getTime());
      if (isActive) {
        active = r;
      } else {
        upcoming.push(r);
      }
    }
    return { active, upcoming };
  }

  /**
   * Creates an on-demand session that begins immediately. Rejects if a
   * non-AUTO session is currently active in the room. A currently-active AUTO
   * session is preempted (`end_override = now`) as part of the same
   * transaction. The session's `scheduled_end_time` is set to the next
   * SCHEDULED or ON_DEMAND session's effective start, or `null` if none.
   * @param data Fields for the new session.
   * @param now The reference instant; becomes `scheduled_start_time`.
   * @returns The created session, `'ROOM_NOT_FOUND'` if the room does not exist, or `'ANOTHER_SESSION_ACTIVE'` if a non-AUTO session is currently active.
   */
  async createOnDemandSession(
    data: CreateOnDemandSessionInput,
    now: Date,
  ): Promise<Session | 'ROOM_NOT_FOUND' | 'ANOTHER_SESSION_ACTIVE'> {
    return this._runWithEvents(async (trx, collector) => {
      const room = await this._repo.lockRoom(trx, data.roomUid);
      if (!room) return 'ROOM_NOT_FOUND' as const;

      const active = await this._repo.findActiveSession(trx, data.roomUid, now);
      if (active !== undefined && active.type !== 'AUTO') {
        return 'ANOTHER_SESSION_ACTIVE' as const;
      }

      // Defer the no-overlap exclusion: we may need to end the active AUTO,
      // delete upcoming AUTO rows, insert the on-demand, and let the
      // reconciler re-materialize, all within one transaction.
      await this._repo.setSessionsConstraintsDeferred(trx);

      if (active?.type === 'AUTO') {
        const newVersion = await this._repo.updateSessionEndOverride(
          trx,
          active.uid,
          now,
        );
        collector.sessionBumps.set(active.uid, newVersion);
      }

      const scheduledEnd = await this._repo.findNextNonAutoSessionStart(
        trx,
        data.roomUid,
        now,
      );

      const inserted = await this._repo.insertSessions(trx, [
        {
          roomUid: data.roomUid,
          name: data.name,
          type: 'ON_DEMAND',
          scheduledSessionUid: null,
          scheduledStartTime: now,
          scheduledEndTime: scheduledEnd,
          joinCodeScopes: data.joinCodeScopes,
          transcriptionProviderId: data.transcriptionProviderId,
          transcriptionStreamConfig: data.transcriptionStreamConfig,
        },
      ]);
      const created = inserted[0];
      if (!created) {
        // Defensive: insertSessions returns one row per input.
        throw new Error('createOnDemandSession: insert returned no rows');
      }

      const windowEnd = addDays(now, MATERIALIZATION_WINDOW_DAYS);
      await reconcileAutoSessions(
        trx,
        this._repo,
        data.roomUid,
        room.timezone,
        now,
        windowEnd,
        MIN_AUTO_SESSION_DURATION_SECONDS,
        room.autoSessionEnabled,
        collector.sessionBumps,
      );

      await this._finalizeRoomWrite(trx, data.roomUid, now, collector);
      return created;
    });
  }

  /**
   * Transitions an upcoming session to ACTIVE before its scheduled start by
   * setting `start_override = now`. The target must be the next upcoming
   * session in its room and not an AUTO session; no other non-AUTO session
   * may be currently active. A currently-active AUTO session is preempted
   * (`end_override = now`) as part of the same transaction.
   * @param uid The session to start early.
   * @param now The reference instant; becomes `start_override`.
   * @returns The updated session, or an error code.
   */
  async startSessionEarly(
    uid: string,
    now: Date,
  ): Promise<
    | Session
    | 'NOT_FOUND'
    | 'NOT_NEXT_UPCOMING'
    | 'ANOTHER_SESSION_ACTIVE'
    | 'SESSION_IS_AUTO'
  > {
    return this._runWithEvents(async (trx, collector) => {
      const session = await this._repo.findSessionByUid(trx, uid);
      if (!session) return 'NOT_FOUND' as const;
      if (session.type === 'AUTO') return 'SESSION_IS_AUTO' as const;

      const room = await this._repo.lockRoom(trx, session.roomUid);
      if (!room) return 'NOT_FOUND' as const;

      // Must be UPCOMING and the room's next upcoming. Both fail with the
      // same code: from the caller's perspective the target isn't eligible
      // because something else (the active session, an earlier upcoming one,
      // or the target already running/ended) is in the way.
      const next = await this._repo.findNextUpcomingSession(
        trx,
        session.roomUid,
        now,
      );
      if (next?.uid !== session.uid) {
        return 'NOT_NEXT_UPCOMING' as const;
      }

      const active = await this._repo.findActiveSession(
        trx,
        session.roomUid,
        now,
      );
      if (active !== undefined && active.type !== 'AUTO') {
        return 'ANOTHER_SESSION_ACTIVE' as const;
      }

      // Defer no-overlap: we end the active AUTO, set start_override on the
      // target (which extends its effective interval backwards), and let the
      // reconciler clean up any AUTO rows that the target now covers.
      await this._repo.setSessionsConstraintsDeferred(trx);

      if (active?.type === 'AUTO') {
        const newVersion = await this._repo.updateSessionEndOverride(
          trx,
          active.uid,
          now,
        );
        collector.sessionBumps.set(active.uid, newVersion);
      }

      const targetVersion = await this._repo.updateSessionStartOverride(
        trx,
        session.uid,
        now,
      );
      collector.sessionBumps.set(session.uid, targetVersion);

      const windowEnd = addDays(now, MATERIALIZATION_WINDOW_DAYS);
      await reconcileAutoSessions(
        trx,
        this._repo,
        session.roomUid,
        room.timezone,
        now,
        windowEnd,
        MIN_AUTO_SESSION_DURATION_SECONDS,
        room.autoSessionEnabled,
        collector.sessionBumps,
      );

      await this._finalizeRoomWrite(trx, session.roomUid, now, collector);

      const updated = await this._repo.findSessionByUid(trx, session.uid);
      // Defensive: the row was just updated, but if it's somehow missing,
      // surface NOT_FOUND rather than throwing.
      return updated ?? ('NOT_FOUND' as const);
    });
  }

  /**
   * Transitions a currently-active session to ENDED by setting
   * `end_override = now`. The target must be currently ACTIVE and not an
   * AUTO session (close the corresponding auto session window instead). The
   * resulting gap is reconciled into AUTO sessions where covered by an
   * active window.
   * @param uid The session to end early.
   * @param now The reference instant; becomes `end_override`.
   * @returns The updated session, or an error code.
   */
  async endSessionEarly(
    uid: string,
    now: Date,
  ): Promise<Session | 'NOT_FOUND' | 'SESSION_NOT_ACTIVE' | 'SESSION_IS_AUTO'> {
    return this._runWithEvents(async (trx, collector) => {
      const session = await this._repo.findSessionByUid(trx, uid);
      if (!session) return 'NOT_FOUND' as const;
      if (session.type === 'AUTO') return 'SESSION_IS_AUTO' as const;

      const room = await this._repo.lockRoom(trx, session.roomUid);
      if (!room) return 'NOT_FOUND' as const;

      const isActive =
        session.effectiveStart.getTime() <= now.getTime() &&
        (session.effectiveEnd === null ||
          session.effectiveEnd.getTime() > now.getTime());
      if (!isActive) return 'SESSION_NOT_ACTIVE' as const;

      await this._repo.setSessionsConstraintsDeferred(trx);
      const newVersion = await this._repo.updateSessionEndOverride(
        trx,
        session.uid,
        now,
      );
      collector.sessionBumps.set(session.uid, newVersion);

      const windowEnd = addDays(now, MATERIALIZATION_WINDOW_DAYS);
      await reconcileAutoSessions(
        trx,
        this._repo,
        session.roomUid,
        room.timezone,
        now,
        windowEnd,
        MIN_AUTO_SESSION_DURATION_SECONDS,
        room.autoSessionEnabled,
        collector.sessionBumps,
      );

      await this._finalizeRoomWrite(trx, session.roomUid, now, collector);

      const updated = await this._repo.findSessionByUid(trx, session.uid);
      return updated ?? ('NOT_FOUND' as const);
    });
  }

  /**
   * Inner schedule-creation logic shared by `createSchedule` and
   * `updateSchedule`. Assumes the caller has already locked the room and
   * runs inside their transaction.
   *
   * @param anchorStart The BIWEEKLY parity reference to persist with the new
   *   schedule. For brand-new schedules this is `data.activeStart`; for
   *   updates the caller passes the existing schedule's `anchorStart` so
   *   cadence is preserved.
   */
  private async _doCreateSchedule(
    trx: Transaction<DB>,
    data: CreateScheduleInput,
    anchorStart: Date,
    room: { uid: string; timezone: string; autoSessionEnabled: boolean },
    now: Date,
    collector: EventCollector,
  ): Promise<
    | Schedule
    | 'CONFLICT'
    | 'INVALID_ACTIVE_START'
    | 'INVALID_ACTIVE_END'
    | 'INVALID_LOCAL_TIMES'
    | 'INVALID_FREQUENCY_FIELDS'
  > {
    // Schedules must produce occurrences strictly in the future; past sessions
    // are immutable history.
    if (data.activeStart.getTime() <= now.getTime()) {
      return 'INVALID_ACTIVE_START';
    }

    // Validate before the DB CHECK fires (local_times_distinct constraint).
    if (data.localStartTime === data.localEndTime) {
      return 'INVALID_LOCAL_TIMES';
    }

    // Validate before the DB CHECK fires (frequency_fields_valid constraint).
    // ONCE must have null daysOfWeek; WEEKLY/BIWEEKLY must have a non-empty array.
    // Note: the DB constraint uses array_length() which returns NULL for an empty
    // array, so PostgreSQL treats [] as passing the CHECK - we must catch it here.
    if (data.frequency === 'ONCE' && data.daysOfWeek !== null) {
      return 'INVALID_FREQUENCY_FIELDS';
    }
    if (
      data.frequency !== 'ONCE' &&
      (data.daysOfWeek === null || data.daysOfWeek.length === 0)
    ) {
      return 'INVALID_FREQUENCY_FIELDS';
    }

    const activeEnd = data.activeEnd ?? null;

    // Reject invalid active range before the DB CHECK fires
    // (session_schedules_active_end_after_start constraint).
    if (
      activeEnd !== null &&
      activeEnd.getTime() <= data.activeStart.getTime()
    ) {
      return 'INVALID_ACTIVE_END';
    }

    // Read overlapping schedules, narrowing by the new schedule's end.
    const others = await this._repo.findSchedulesOverlapping(
      trx,
      data.roomUid,
      {
        from: data.activeStart,
        to: activeEnd,
      },
    );

    const candidate: ScheduleForMaterialization = {
      uid: '__candidate__',
      activeStart: data.activeStart,
      activeEnd,
      anchorStart,
      localStartTime: data.localStartTime,
      localEndTime: data.localEndTime,
      frequency: data.frequency,
      daysOfWeek: data.daysOfWeek,
    };

    for (const other of others) {
      if (
        detectConflict(
          candidate,
          scheduleToMaterializationRecord(other),
          room.timezone,
          now,
          CONFLICT_CHECK_HORIZON_DAYS,
        )
      ) {
        return 'CONFLICT';
      }
    }

    const schedule = await this._repo.insertSchedule(trx, {
      ...data,
      anchorStart,
    });

    const windowEnd = addDays(now, MATERIALIZATION_WINDOW_DAYS);
    // The materializer already trims to `min(activeEnd, windowEnd)` when the
    // schedule has a non-null activeEnd, so we pass windowEnd directly.
    const occurrences = materializeSchedule(
      scheduleToMaterializationRecord(schedule),
      room.timezone,
      maxDate(now, schedule.activeStart),
      windowEnd,
    );
    if (occurrences.length > 0) {
      await this._repo.setSessionsConstraintsDeferred(trx);
      await this._repo.insertSessions(
        trx,
        occurrences.map((o) => buildScheduledSessionRow(schedule, o)),
      );
    }

    await reconcileAutoSessions(
      trx,
      this._repo,
      data.roomUid,
      room.timezone,
      now,
      windowEnd,
      MIN_AUTO_SESSION_DURATION_SECONDS,
      room.autoSessionEnabled,
      collector.sessionBumps,
    );

    await this._realignActiveOnDemandSession(trx, data.roomUid, now, collector);

    return schedule;
  }

  /**
   * Inner schedule-deletion logic shared by `deleteSchedule` and
   * `updateSchedule`. Locks the room itself and reconciles AUTO sessions, but
   * leaves the room-write finalization (version bump, materialized stamp) to
   * the caller.
   * @returns `{ roomUid }` so callers can finalize the room write, or `'NOT_FOUND'` if the schedule is missing or already closed.
   */
  private async _doDeleteSchedule(
    trx: Transaction<DB>,
    uid: string,
    now: Date,
    collector: EventCollector,
  ): Promise<{ roomUid: string } | 'NOT_FOUND'> {
    const schedule = await this._repo.findScheduleByUid(trx, uid);
    if (schedule?.activeEnd !== null) return 'NOT_FOUND' as const;

    const room = await this._repo.lockRoom(trx, schedule.roomUid);
    if (!room) return 'NOT_FOUND' as const;

    if (schedule.activeStart.getTime() > now.getTime()) {
      // Schedule never took effect: hard-delete; cascade removes UPCOMING sessions.
      await this._repo.deleteScheduleHard(trx, uid);
    } else {
      const latest = await this._repo.findLatestPastOrActiveSessionForSchedule(
        trx,
        uid,
        now,
      );
      // Schedule has produced at least one realized session - close at its
      // effective end. If a session was realized but has no scheduled_end
      // (open-ended ON_DEMAND-style data, shouldn't happen for SCHEDULED) we
      // fall back to `now`. In the rare case there's no realized session at
      // all (e.g. active_start <= now but no occurrence ever materialized), we
      // close at max(now, active_start + 1ms) to satisfy the > active_start
      // CHECK constraint.
      const closeAt =
        latest?.effectiveEnd ??
        maxDate(now, new Date(schedule.activeStart.getTime() + 1));
      await this._repo.updateScheduleActiveEnd(trx, uid, closeAt);
      await this._repo.deleteUpcomingSessionsForSchedule(trx, uid, now);
    }

    const windowEnd = addDays(now, MATERIALIZATION_WINDOW_DAYS);
    await reconcileAutoSessions(
      trx,
      this._repo,
      schedule.roomUid,
      room.timezone,
      now,
      windowEnd,
      MIN_AUTO_SESSION_DURATION_SECONDS,
      room.autoSessionEnabled,
      collector.sessionBumps,
    );

    await this._realignActiveOnDemandSession(
      trx,
      schedule.roomUid,
      now,
      collector,
    );

    return { roomUid: schedule.roomUid };
  }

  /**
   * Inner window-creation logic shared by `createAutoSessionWindow` and
   * `updateAutoSessionWindow`. Performs the materialization-based overlap
   * check against existing windows, persists the row, and reconciles AUTO
   * sessions.
   */
  private async _doCreateWindow(
    trx: Transaction<DB>,
    data: CreateWindowInput,
    room: { uid: string; timezone: string; autoSessionEnabled: boolean },
    now: Date,
    collector: EventCollector,
    options: { skipReconcile?: boolean } = {},
  ): Promise<AutoSessionWindow | 'CONFLICT' | 'INVALID_ACTIVE_END'> {
    const { activeStart, activeEnd } = data;
    if (activeEnd !== null && activeEnd.getTime() <= activeStart.getTime()) {
      return 'INVALID_ACTIVE_END';
    }

    const windowEnd = addDays(now, MATERIALIZATION_WINDOW_DAYS);

    // Overlap check: expand the candidate and each existing window over the
    // materialization window and look for any overlapping pair. The
    // candidate's `activeEnd` (when set) bounds its own expansion via
    // schedule-materializer's internal trim.
    const candidateForExpansion: AutoSessionWindow = {
      uid: '__candidate__',
      roomUid: data.roomUid,
      localStartTime: data.localStartTime,
      localEndTime: data.localEndTime,
      daysOfWeek: data.daysOfWeek,
      transcriptionProviderId: data.transcriptionProviderId,
      transcriptionStreamConfig: data.transcriptionStreamConfig,
      activeStart,
      activeEnd,
      createdAt: now,
    };

    const horizonEnd = addDays(
      maxDate(activeStart, now),
      CONFLICT_CHECK_HORIZON_DAYS,
    );
    const candidateRanges = materializeWindow(
      candidateForExpansion,
      room.timezone,
      maxDate(activeStart, now),
      horizonEnd,
    );

    const others = await this._repo.findWindowsOverlapping(trx, data.roomUid, {
      from: activeStart,
      to: activeEnd,
    });

    for (const other of others) {
      const otherRanges = materializeWindow(
        other,
        room.timezone,
        maxDate(activeStart, now),
        horizonEnd,
      );
      if (rangesOverlap(candidateRanges, otherRanges)) {
        return 'CONFLICT' as const;
      }
    }

    // Persist the resolved activeStart so the materializer reads it back
    // consistently (otherwise the DB default `now()` wins and the recorded
    // start drifts from what conflict-checking just used).
    const window = await this._repo.insertWindow(trx, {
      ...data,
      activeStart,
      activeEnd,
    });

    if (!options.skipReconcile) {
      await reconcileAutoSessions(
        trx,
        this._repo,
        data.roomUid,
        room.timezone,
        now,
        windowEnd,
        MIN_AUTO_SESSION_DURATION_SECONDS,
        room.autoSessionEnabled,
        collector.sessionBumps,
      );
    }

    return window;
  }

  /**
   * Inner window-deletion logic shared by `deleteAutoSessionWindow` and
   * `updateAutoSessionWindow`. Locks the room and reconciles AUTO sessions
   * but leaves room-write finalization to the caller.
   * @returns `{ roomUid }` so callers can finalize the room write, or `'NOT_FOUND'` if the window is missing or already closed.
   */
  private async _doDeleteWindow(
    trx: Transaction<DB>,
    uid: string,
    now: Date,
    collector: EventCollector,
    options: { skipReconcile?: boolean } = {},
  ): Promise<{ roomUid: string } | 'NOT_FOUND'> {
    const window = await this._repo.findWindowByUid(trx, uid);
    if (window?.activeEnd !== null) return 'NOT_FOUND' as const;

    const room = await this._repo.lockRoom(trx, window.roomUid);
    if (!room) return 'NOT_FOUND' as const;

    if (window.activeStart.getTime() > now.getTime()) {
      await this._repo.deleteWindowHard(trx, uid);
    } else {
      const closeAt = maxDate(now, new Date(window.activeStart.getTime() + 1));
      await this._repo.updateWindowActiveEnd(trx, uid, closeAt);
    }

    if (!options.skipReconcile) {
      const windowEnd = addDays(now, MATERIALIZATION_WINDOW_DAYS);
      await reconcileAutoSessions(
        trx,
        this._repo,
        window.roomUid,
        room.timezone,
        now,
        windowEnd,
        MIN_AUTO_SESSION_DURATION_SECONDS,
        room.autoSessionEnabled,
        collector.sessionBumps,
      );
    }

    return { roomUid: window.roomUid };
  }

  /**
   * Recomputes `scheduled_end_time` on the room's currently-active ON_DEMAND
   * session so that it ends at the next SCHEDULED session's start (or stays
   * open-ended if none exist). Run after schedule writes that may have moved
   * or removed the next SCHEDULED occurrence.
   */
  private async _realignActiveOnDemandSession(
    trx: Transaction<DB>,
    roomUid: string,
    now: Date,
    collector: EventCollector,
  ): Promise<void> {
    const activeOd = await this._repo.findActiveOnDemandSession(
      trx,
      roomUid,
      now,
    );
    if (!activeOd) return;
    const after = maxDate(now, activeOd.effectiveStart);
    const nextStart = await this._repo.findNextNonAutoSessionStart(
      trx,
      roomUid,
      after,
    );
    const currentEnd = activeOd.effectiveEnd?.getTime() ?? null;
    const newEnd = nextStart?.getTime() ?? null;
    if (currentEnd !== newEnd) {
      const newVersion = await this._repo.updateSessionScheduledEnd(
        trx,
        activeOd.uid,
        nextStart,
      );
      collector.sessionBumps.set(activeOd.uid, newVersion);
    }
  }

  /**
   * Bumps `room_schedule_version` and stamps `last_materialized_at` on the
   * room. Run once at the end of every successful write so polling clients
   * observe a single version increment per logical operation. Records the
   * new room version in `collector` so the caller can publish a
   * `RoomScheduleVersionBumped` event after the transaction commits.
   */
  private async _finalizeRoomWrite(
    trx: Transaction<DB>,
    roomUid: string,
    now: Date,
    collector: EventCollector,
  ): Promise<void> {
    const roomScheduleVersion = await this._repo.bumpScheduleVersion(
      trx,
      roomUid,
    );
    await this._repo.touchLastMaterializedAt(trx, roomUid, now);
    collector.roomBump = { roomUid, roomScheduleVersion };
    this._log.debug({ roomUid }, 'schedule-management write committed');
  }
}

/**
 * Returns true if any range in `a` overlaps any range in `b`. Inputs are
 * assumed to be small (a daily materialization across a one-week sample), so
 * a quadratic scan is fine.
 */
function rangesOverlap(
  a: { startUtc: Date; endUtc: Date }[],
  b: { startUtc: Date; endUtc: Date }[],
): boolean {
  // Both lists are produced from a daily materialization, so each is small
  // (at most 7 entries each within a one-week sample). A double loop is fine.
  for (const x of a) {
    for (const y of b) {
      if (
        x.startUtc.getTime() < y.endUtc.getTime() &&
        y.startUtc.getTime() < x.endUtc.getTime()
      ) {
        return true;
      }
    }
  }
  return false;
}
