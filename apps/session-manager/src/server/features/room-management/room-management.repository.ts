import { type Updateable, sql } from 'kysely';
import type { SelectQueryBuilder } from 'kysely';

import type { DB, Rooms } from '@scribear/scribear-db';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import {
  decodeCursor,
  encodeCreatedAtCursor,
  encodeSimilarityCursor,
} from '#src/server/utils/pagination.js';

interface RoomRow {
  uid: string;
  name: string;
  timezone: string;
  auto_session_enabled: boolean;
  room_schedule_version: string;
  created_at: Date;
}

type BaseRoomQuery = SelectQueryBuilder<DB, 'rooms', RoomRow>;

/**
 * Maps a room database row to an internal room object.
 * @param row The database row to map.
 * @returns Internal room object.
 */
function mapRoom(row: RoomRow) {
  return {
    uid: row.uid,
    name: row.name,
    timezone: row.timezone,
    autoSessionEnabled: row.auto_session_enabled,
    roomScheduleVersion: Number(row.room_schedule_version),
    createdAt: row.created_at,
  };
}

/**
 * Slices a raw result set into a page and signals whether more rows exist.
 * Callers should fetch `limit + 1` rows and pass them here; the extra row is
 * never included in `items` but its presence sets `hasMore`.
 * @param rows Raw rows fetched from the database (`limit + 1` requested).
 * @param limit Maximum number of items to return.
 */
function buildPage<T>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, hasMore, last: items.at(-1) };
}

export class RoomManagementRepository {
  private _dbClient: AppDependencies['dbClient'];

  constructor(dbClient: AppDependencies['dbClient']) {
    this._dbClient = dbClient;
  }

  /**
   * Fetches a single room by UID.
   * @param roomUid The room's unique identifier.
   * @returns The mapped room, or `undefined` if not found.
   */
  async findById(roomUid: string) {
    const row = await this._dbClient.db
      .selectFrom('rooms')
      .select([
        'uid',
        'name',
        'timezone',
        'auto_session_enabled',
        'room_schedule_version',
        'created_at',
      ])
      .where('uid', '=', roomUid)
      .executeTakeFirst();

    return row ? mapRoom(row) : undefined;
  }

  /**
   * Lists rooms with optional fuzzy search and cursor-based pagination.
   * When `search` is provided results are ordered by trigram similarity
   * descending and the cursor encodes `(similarity, uid)`. Without `search`,
   * results are ordered by `created_at` ascending and the cursor encodes
   * `(createdAt, uid)`.
   * @param params.search Fuzzy name filter using pg_trgm word similarity.
   * @param params.cursor Opaque cursor from a previous response's `nextCursor` field.
   * @param params.limit Maximum number of items to return.
   */
  async list(params: {
    search: string | null;
    cursor: string | null;
    limit: number;
  }) {
    const { search, cursor, limit } = params;

    const base: BaseRoomQuery = this._dbClient.db
      .selectFrom('rooms')
      .select([
        'uid',
        'name',
        'timezone',
        'auto_session_enabled',
        'room_schedule_version',
        'created_at',
      ]);

    return search !== null
      ? this._listBySimilarity(base, search, cursor, limit)
      : this._listByCreatedAt(base, cursor, limit);
  }

  /**
   * Executes the similarity-search pagination path. Orders by `word_similarity` descending,
   * breaking ties by `uid` ascending. The cursor encodes `(similarity, uid)`.
   */
  private async _listBySimilarity(
    base: BaseRoomQuery,
    search: string,
    rawCursor: string | null,
    limit: number,
  ) {
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    const simCursor = cursor?.type === 'similarity' ? cursor : null;

    let q = base
      .where(sql`word_similarity(${search}, name)`, '>', 0.3)
      .select(sql<number>`word_similarity(${search}, name)`.as('_similarity'));

    if (simCursor) {
      q = q.where((eb) =>
        eb.or([
          eb(sql`word_similarity(${search}, name)`, '<', simCursor.similarity),
          eb.and([
            eb(
              sql`word_similarity(${search}, name)`,
              '=',
              simCursor.similarity,
            ),
            eb('uid', '>', simCursor.uid),
          ]),
        ]),
      );
    }

    const rows = (await q
      .orderBy(sql`word_similarity(${search}, name) desc`)
      .orderBy('uid', 'asc')
      .limit(limit + 1)
      // eslint-disable-next-line @typescript-eslint/naming-convention
      .execute()) as (RoomRow & { _similarity: number })[];

    const { items, hasMore, last } = buildPage(rows, limit);
    return {
      items: items.map(mapRoom),
      nextCursor:
        hasMore && last
          ? encodeSimilarityCursor(last._similarity, last.uid)
          : null,
    };
  }

  /**
   * Executes the chronological pagination path. Orders by `created_at` ascending,
   * breaking ties by `uid` ascending. The cursor encodes `(createdAt, uid)`.
   */
  private async _listByCreatedAt(
    base: BaseRoomQuery,
    rawCursor: string | null,
    limit: number,
  ) {
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    const createdAtCursor = cursor?.type === 'createdAt' ? cursor : null;

    if (createdAtCursor) {
      const ts = new Date(createdAtCursor.createdAt);
      base = base.where((eb) =>
        eb.or([
          eb(sql`date_trunc('milliseconds', created_at)`, '>', ts),
          eb.and([
            eb(sql`date_trunc('milliseconds', created_at)`, '=', ts),
            eb('uid', '>', createdAtCursor.uid),
          ]),
        ]),
      );
    }

    const rows = (await base
      .orderBy('created_at', 'asc')
      .orderBy('uid', 'asc')
      .limit(limit + 1)
      .execute()) as RoomRow[];

    const { items, hasMore, last } = buildPage(rows, limit);
    return {
      items: items.map(mapRoom),
      nextCursor:
        hasMore && last
          ? encodeCreatedAtCursor(last.created_at, last.uid)
          : null,
    };
  }

  /**
   * Inserts a new room.
   * @param data.name The display name for the room.
   * @param data.timezone A valid IANA timezone identifier.
   * @param data.autoSessionEnabled Master switch for auto sessions in this room.
   * @returns The newly created room.
   */
  async create(data: {
    name: string;
    timezone: string;
    autoSessionEnabled: boolean;
  }) {
    const row = await this._dbClient.db
      .insertInto('rooms')
      .values({
        name: data.name,
        timezone: data.timezone,
        auto_session_enabled: data.autoSessionEnabled,
      })
      .returning([
        'uid',
        'name',
        'timezone',
        'auto_session_enabled',
        'room_schedule_version',
        'created_at',
      ])
      .executeTakeFirstOrThrow();

    return mapRoom(row);
  }

  /**
   * Idempotently inserts a room with an explicit, caller-chosen `uid`,
   * mirroring `ScheduleManagementRepository.insertSessionWithUid`: on a
   * primary-key conflict the insert is a no-op and the already-persisted row
   * is returned. Used by the demo room seeder, which must survive restarts
   * and racing instances without accumulating duplicate demo rooms (there is
   * no unique constraint on `name` to lean on instead).
   * @param uid The fixed uid to insert (or look up on conflict).
   * @param data.name The display name for the room.
   * @param data.timezone A valid IANA timezone identifier.
   * @param data.autoSessionEnabled Master switch for auto sessions in this room.
   * @returns The persisted room (either just-inserted or pre-existing).
   */
  async createWithFixedUid(
    uid: string,
    data: { name: string; timezone: string; autoSessionEnabled: boolean },
  ) {
    await this._dbClient.db
      .insertInto('rooms')
      .values({
        uid,
        name: data.name,
        timezone: data.timezone,
        auto_session_enabled: data.autoSessionEnabled,
      })
      .onConflict((oc) => oc.column('uid').doNothing())
      .execute();

    const persisted = await this.findById(uid);
    if (!persisted) {
      throw new Error(
        `createWithFixedUid: no room found for uid ${uid} after insert`,
      );
    }
    return persisted;
  }

  /**
   * Updates a room's display name. Schedule-affecting fields (`timezone`,
   * `auto_session_enabled`) are not exposed here; use
   * `ScheduleManagementService.updateRoomScheduleConfig` for those, since
   * changing them requires re-materializing sessions atomically. Returns the
   * current state via `findById` when no fields are provided.
   * @param roomUid The room to update.
   * @param data Fields to update; any omitted field is left unchanged.
   */
  async update(
    roomUid: string,
    data: {
      name?: string;
    },
  ) {
    const updates: Partial<Updateable<Rooms>> = {};
    if (data.name !== undefined) updates.name = data.name;

    if (Object.keys(updates).length === 0) {
      return this.findById(roomUid);
    }

    const row = await this._dbClient.db
      .updateTable('rooms')
      .set(updates)
      .where('uid', '=', roomUid)
      .returning([
        'uid',
        'name',
        'timezone',
        'auto_session_enabled',
        'room_schedule_version',
        'created_at',
      ])
      .executeTakeFirst();

    return row ? mapRoom(row) : undefined;
  }

  /**
   * Deletes a room by UID. Cascades to `room_devices`.
   * @param roomUid The room to delete.
   * @returns `true` if a row was deleted, `false` if the room did not exist.
   */
  async delete(roomUid: string): Promise<boolean> {
    const result = await this._dbClient.db
      .deleteFrom('rooms')
      .where('uid', '=', roomUid)
      .returning('uid')
      .executeTakeFirst();

    return result !== undefined;
  }

  /**
   * Adds a device to a room. If `asSource` is true, clears all existing source devices first.
   * The clear and insert run in a single transaction.
   * @param roomUid The room to add the device to.
   * @param deviceUid The device to add.
   * @param asSource Whether to designate this device as the room's source.
   */
  async addDeviceToRoom(
    roomUid: string,
    deviceUid: string,
    asSource: boolean,
  ): Promise<void> {
    await this._dbClient.db.transaction().execute(async (trx) => {
      if (asSource) {
        await trx
          .updateTable('room_devices')
          .set({ is_source: false })
          .where('room_uid', '=', roomUid)
          .execute();
      }
      await trx
        .insertInto('room_devices')
        .values({
          room_uid: roomUid,
          device_uid: deviceUid,
          is_source: asSource,
        })
        .execute();
    });
  }

  /**
   * Idempotently makes `deviceUid` the source device of `roomUid`.
   *
   * Unlike {@link addDeviceToRoom}, which has no conflict handling and throws on
   * a second call, this is safe to run on every boot: the membership row is
   * inserted if absent and left as the source if present. That is what the
   * test-audio seeder needs — a plain insert would fail on the second boot with
   * a primary-key violation, and the seeder must be a no-op on a stack that has
   * simply been restarted.
   *
   * `DO UPDATE SET is_source = TRUE` rather than `DO NOTHING` is belt and
   * braces rather than the main event: the `room_devices_ensure_source` and
   * `room_devices_single_source` constraint triggers already make a demoted lone
   * source unreachable through any API path (there is nothing to promote in its
   * place, and room-management refuses to add one to a test-audio room), so in
   * practice the conflict branch finds `is_source` already true. It is written
   * to converge anyway because a `DO NOTHING` here would silently accept a
   * hand-edited row that a re-seed is the natural remedy for.
   *
   * `ON CONFLICT (room_uid, device_uid)` is the primary key. The other unique
   * index on this table — `idx_room_devices_device`, one room per device — is
   * deliberately *not* handled: a conflict there means the device has been moved
   * into a different room, which for a seeded synthetic source is exactly the
   * situation that must fail loudly rather than be silently reconciled. Callers
   * check for it before calling.
   *
   * @param roomUid The room the device is the source of.
   * @param deviceUid The device to insert or promote.
   */
  async upsertSourceDevice(roomUid: string, deviceUid: string): Promise<void> {
    await this._dbClient.db
      .insertInto('room_devices')
      .values({ room_uid: roomUid, device_uid: deviceUid, is_source: true })
      .onConflict((oc) =>
        oc.columns(['room_uid', 'device_uid']).doUpdateSet({ is_source: true }),
      )
      .execute();
  }

  /**
   * Removes a device from whichever room it belongs to.
   * @param deviceUid The device to remove.
   * @returns `true` if the membership row was deleted, `false` if the device was not in any room.
   */
  async removeDeviceFromRoom(deviceUid: string): Promise<boolean> {
    const result = await this._dbClient.db
      .deleteFrom('room_devices')
      .where('device_uid', '=', deviceUid)
      .returning('device_uid')
      .executeTakeFirst();

    return result !== undefined;
  }

  /**
   * Clears all source flags in the room, then promotes the target device. Runs in a single transaction.
   * @param roomUid The room to update.
   * @param deviceUid The device to promote to source; must already be a member of the room.
   * @returns `false` if the device is not a member of the room.
   */
  async setSourceDevice(roomUid: string, deviceUid: string): Promise<boolean> {
    let updated = false;
    await this._dbClient.db.transaction().execute(async (trx) => {
      const membership = await trx
        .selectFrom('room_devices')
        .select('device_uid')
        .where('room_uid', '=', roomUid)
        .where('device_uid', '=', deviceUid)
        .executeTakeFirst();

      if (!membership) return;

      await trx
        .updateTable('room_devices')
        .set({ is_source: false })
        .where('room_uid', '=', roomUid)
        .execute();

      await trx
        .updateTable('room_devices')
        .set({ is_source: true })
        .where('room_uid', '=', roomUid)
        .where('device_uid', '=', deviceUid)
        .execute();

      updated = true;
    });
    return updated;
  }

  /**
   * Returns the room membership row for a device.
   * @param deviceUid The device to look up.
   * @returns `{ room_uid, is_source }` if the device is in a room, `undefined` otherwise.
   */
  async findRoomMembership(
    deviceUid: string,
  ): Promise<{ room_uid: string; is_source: boolean } | undefined> {
    return await this._dbClient.db
      .selectFrom('room_devices')
      .select(['room_uid', 'is_source'])
      .where('device_uid', '=', deviceUid)
      .executeTakeFirst();
  }

  /**
   * Checks whether a room with the given UID exists.
   * @param roomUid The room UID to check.
   * @returns `true` if the room exists, `false` otherwise.
   */
  async findRoomExists(roomUid: string): Promise<boolean> {
    const row = await this._dbClient.db
      .selectFrom('rooms')
      .select('uid')
      .where('uid', '=', roomUid)
      .executeTakeFirst();
    return row !== undefined;
  }
}
