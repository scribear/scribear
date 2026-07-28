import { sql } from 'kysely';
import type { SelectQueryBuilder } from 'kysely';

import type { DB } from '@scribear/scribear-db';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import {
  decodeCursor,
  encodeCreatedAtCursor,
  encodeSimilarityCursor,
} from '#src/server/utils/pagination.js';

interface DeviceRow {
  uid: string;
  name: string;
  active: boolean;
  created_at: Date;
  last_seen_at: Date | null;
  room_uid: string | null;
  is_source: boolean | null;
}

type BaseDeviceQuery = SelectQueryBuilder<
  DB,
  'devices' | 'room_devices',
  DeviceRow
>;

/**
 * Map a device database row to internal device object
 * @param row The database row to map
 * @returns Internal device object
 */
function mapDevice(row: DeviceRow) {
  return {
    uid: row.uid,
    name: row.name,
    active: row.active,
    createdAt: row.created_at,
    // Null means the device has not been heard from since B1.6 shipped, which
    // is deliberately distinct from a stamped-at-migration-time value that
    // would have shown the whole fleet as freshly online.
    lastSeenAt: row.last_seen_at,
    roomUid: row.room_uid,
    isSource: row.is_source,
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

export class DeviceManagementRepository {
  private _dbClient: AppDependencies['dbClient'];

  constructor(dbClient: AppDependencies['dbClient']) {
    this._dbClient = dbClient;
  }

  /**
   * Fetches a device by UID, joining room membership fields.
   * @param deviceUid The device's unique identifier.
   * @returns The device with `roomUid` and `isSource` fields, or `undefined` if not found.
   */
  async findById(deviceUid: string) {
    const row = await this._dbClient.db
      .selectFrom('devices')
      .leftJoin('room_devices', 'room_devices.device_uid', 'devices.uid')
      .select([
        'devices.uid',
        'devices.name',
        'devices.active',
        'devices.created_at',
        'devices.last_seen_at',
        'room_devices.room_uid',
        'room_devices.is_source',
      ])
      .where('devices.uid', '=', deviceUid)
      .executeTakeFirst();

    return row ? mapDevice(row) : undefined;
  }

  /**
   * Lists devices with optional fuzzy search, filtering, and cursor-based
   * pagination. When `search` is provided results are ordered by trigram
   * similarity descending and the cursor encodes `(similarity, uid)`. Without
   * `search`, results are ordered by `created_at` ascending and the cursor
   * encodes `(createdAt, uid)`. Pass `undefined` for any non-search filter to
   * disable it.
   * @param params.search Fuzzy name filter using pg_trgm word similarity.
   * @param params.active Filter by activation state.
   * @param params.roomUid Filter by room membership, pass `''` to return only devices not in any room.
   * @param params.cursor Opaque cursor from a previous response's `nextCursor` field, undefined for first page.
   * @param params.limit Maximum number of items to return.
   */
  async list(params: {
    search: string | null;
    active: boolean | null;
    roomUid: string | null;
    cursor: string | null;
    limit: number;
  }) {
    const { search, active, roomUid, cursor, limit } = params;

    let base: BaseDeviceQuery = this._dbClient.db
      .selectFrom('devices')
      .leftJoin('room_devices', 'room_devices.device_uid', 'devices.uid')
      .select([
        'devices.uid',
        'devices.name',
        'devices.active',
        'devices.created_at',
        'devices.last_seen_at',
        'room_devices.room_uid',
        'room_devices.is_source',
      ]) as BaseDeviceQuery;

    if (active !== null) base = base.where('devices.active', '=', active);
    if (roomUid !== null) {
      base =
        roomUid === ''
          ? base.where('room_devices.device_uid', 'is', null)
          : base.where('room_devices.room_uid', '=', roomUid);
    }

    return search !== null
      ? this._listBySimilarity(base, search, cursor, limit)
      : this._listByCreatedAt(base, cursor, limit);
  }

  /**
   * Executes the similarity-search pagination path. Orders by `word_similarity` descending,
   * breaking ties by `uid` ascending. The cursor encodes `(similarity, uid)`.
   */
  private async _listBySimilarity(
    base: BaseDeviceQuery,
    search: string,
    rawCursor: string | null,
    limit: number,
  ) {
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    const simCursor = cursor?.type === 'similarity' ? cursor : null;

    let q = base
      .where(sql`word_similarity(${search}, devices.name)`, '>', 0.3)
      .select(
        sql<number>`word_similarity(${search}, devices.name)`.as('_similarity'),
      );

    if (simCursor) {
      q = q.where((eb) =>
        eb.or([
          eb(
            sql`word_similarity(${search}, devices.name)`,
            '<',
            simCursor.similarity,
          ),
          eb.and([
            eb(
              sql`word_similarity(${search}, devices.name)`,
              '=',
              simCursor.similarity,
            ),
            eb('devices.uid', '>', simCursor.uid),
          ]),
        ]),
      );
    }

    const rows = (await q
      .orderBy(sql`word_similarity(${search}, devices.name) desc`)
      .orderBy('devices.uid', 'asc')
      .limit(limit + 1)
      // eslint-disable-next-line @typescript-eslint/naming-convention
      .execute()) as (DeviceRow & { _similarity: number })[];

    const { items, hasMore, last } = buildPage(rows, limit);
    return {
      items: items.map(mapDevice),
      nextCursor:
        hasMore && last
          ? encodeSimilarityCursor(last._similarity, last.uid)
          : null,
    };
  }

  /**
   * Executes the chronological pagination path. Orders by `created_at`
   * ascending, breaking ties by `uid` ascending. The cursor encodes
   * `(createdAt, uid)`.
   *
   * Both the ordering key and the cursor predicate truncate `created_at` to
   * milliseconds, and they have to agree. `created_at` is a `timestamptz`
   * with microsecond resolution, but the cursor round-trips through a JS
   * `Date` and an ISO-8601 string, neither of which can carry more than
   * milliseconds - so the cursor can only ever name a millisecond. Ordering
   * on the raw column while filtering on the truncated one lets the two
   * disagree about which side of the cursor a row falls on: rows sharing a
   * millisecond but differing in microseconds get ordered by their
   * microseconds into page N, then re-selected by the `uid` tiebreak into
   * page N+1, duplicating rows and inflating the page. Registering three
   * rows inside one millisecond is enough to hit it, which is why the
   * pagination tests were intermittently failing.
   */
  private async _listByCreatedAt(
    base: BaseDeviceQuery,
    rawCursor: string | null,
    limit: number,
  ) {
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    const createdAtCursor = cursor?.type === 'createdAt' ? cursor : null;
    const orderKey = sql`date_trunc('milliseconds', devices.created_at)`;

    if (createdAtCursor) {
      const ts = new Date(createdAtCursor.createdAt);
      base = base.where((eb) =>
        eb.or([
          eb(orderKey, '>', ts),
          eb.and([
            eb(orderKey, '=', ts),
            eb('devices.uid', '>', createdAtCursor.uid),
          ]),
        ]),
      );
    }

    const rows = (await base
      .orderBy(orderKey, 'asc')
      .orderBy('devices.uid', 'asc')
      .limit(limit + 1)
      .execute()) as DeviceRow[];

    const { items, hasMore, last } = buildPage(rows, limit);
    return {
      items: items.map(mapDevice),
      nextCursor:
        hasMore && last
          ? encodeCreatedAtCursor(last.created_at, last.uid)
          : null,
    };
  }

  /**
   * Inserts a new device in the pending (unactivated) state.
   * @param data.name The display name for the device.
   * @param data.activationCode The one-time activation code.
   * @param data.expiry The expiry timestamp for the activation code.
   * @returns The new device's UID and name.
   */
  async create(data: { name: string; activationCode: string; expiry: Date }) {
    return await this._dbClient.db
      .insertInto('devices')
      .values({
        name: data.name,
        activation_code: data.activationCode,
        expiry: data.expiry,
      })
      .returning(['uid', 'name'])
      .executeTakeFirstOrThrow();
  }

  /**
   * Idempotently inserts a device with an explicit, caller-chosen `uid`,
   * mirroring `ScheduleManagementRepository.insertSessionWithUid`: on a
   * primary-key conflict the insert is a no-op and the already-persisted row
   * is returned. Used by the demo room seeder, which must survive restarts
   * and racing instances without accumulating duplicate placeholder devices
   * (there is no unique constraint on `name` to lean on instead).
   * @param uid The fixed uid to insert (or look up on conflict).
   * @param data.name The display name for the device.
   * @param data.activationCode The one-time activation code (ignored on conflict).
   * @param data.expiry The expiry timestamp for the activation code (ignored on conflict).
   * @returns The persisted device (either just-inserted or pre-existing).
   */
  async createWithFixedUid(
    uid: string,
    data: { name: string; activationCode: string; expiry: Date },
  ) {
    await this._dbClient.db
      .insertInto('devices')
      .values({
        uid,
        name: data.name,
        activation_code: data.activationCode,
        expiry: data.expiry,
      })
      .onConflict((oc) => oc.column('uid').doNothing())
      .execute();

    const persisted = await this.findById(uid);
    if (!persisted) {
      throw new Error(
        `createWithFixedUid: no device found for uid ${uid} after insert`,
      );
    }
    return persisted;
  }

  /**
   * Idempotently inserts an **already-activated** device with an explicit
   * caller-chosen `uid`, and re-writes its credential on every call.
   *
   * The counterpart of {@link createWithFixedUid} for a device whose secret is
   * not minted by `activate-device` but *derived* — the seeded operator
   * test-audio sources, whose plaintext secret both this service and the
   * generator compute from `TEST_AUDIO_DEVICE_SECRET`. The row therefore has to
   * be written in the activated shape (`active = TRUE`, `hash` set,
   * `activation_code`/`expiry` null) to satisfy the `devices_active_has_hash`
   * CHECK; there is no pending state to pass through, because nobody ever holds
   * an activation code for these.
   *
   * `DO UPDATE` rather than `DO NOTHING`, deliberately, and this is the whole
   * reason the method exists separately:
   *
   *  - bcrypt is salted, so the stored hash is *not* a deterministic function of
   *    the secret and cannot be used to detect drift. Re-hashing unconditionally
   *    is the only cheap way to guarantee the row agrees with the environment.
   *  - it makes **secret rotation automatic**: change `TEST_AUDIO_DEVICE_SECRET`
   *    on both services, restart, and the stored hash and the derived token move
   *    together. With `DO NOTHING` the stored hash would keep verifying the old
   *    secret and the generator would fail to authenticate with no indication
   *    that a stale row was the reason.
   *  - it **repairs** a device an operator re-registered (`reregister` sets
   *    `active = FALSE, hash = NULL`), which would otherwise leave the source
   *    permanently unable to authenticate with a restart no longer fixing it.
   *
   * It updates one existing row and never inserts a second: the conflict target
   * is the primary key. Nothing in the stack watches `devices` rows — presence
   * lives in its own `device_last_seen` table and no event-bus channel is keyed
   * on a device — so the per-boot write churns nothing.
   *
   * @param uid The fixed uid to insert, or whose credential to replace.
   * @param data.name The display name for the device (also re-applied on conflict).
   * @param data.hash The bcrypt hash of the device's derived secret.
   * @returns The persisted device.
   */
  async upsertActivatedWithFixedUid(
    uid: string,
    data: { name: string; hash: string },
  ) {
    await this._dbClient.db
      .insertInto('devices')
      .values({
        uid,
        name: data.name,
        active: true,
        hash: data.hash,
        activation_code: null,
        expiry: null,
      })
      .onConflict((oc) =>
        oc.column('uid').doUpdateSet({
          name: data.name,
          active: true,
          hash: data.hash,
          activation_code: null,
          expiry: null,
        }),
      )
      .execute();

    const persisted = await this.findById(uid);
    if (!persisted) {
      throw new Error(
        `upsertActivatedWithFixedUid: no device found for uid ${uid} after upsert`,
      );
    }
    return persisted;
  }

  /**
   * Looks up a device by its pending activation code.
   * @param activationCode The one-time code to look up.
   * @returns The matching device row, or `undefined` if the code does not exist.
   */
  async findByActivationCode(activationCode: string) {
    return await this._dbClient.db
      .selectFrom('devices')
      .select(['uid', 'name', 'active', 'expiry'])
      .where('activation_code', '=', activationCode)
      .executeTakeFirst();
  }

  /**
   * Activates a device by consuming its activation code. Sets `active = true` and clears `activation_code` and `expiry`.
   * Guards with `active = false` to prevent double-activation.
   * @param activationCode The one-time activation code to consume.
   * @param hash The bcrypt hash of the device's new secret.
   * @returns The activated device row, or `undefined` if the code was not found or already consumed.
   */
  async activate(activationCode: string, hash: string) {
    return await this._dbClient.db
      .updateTable('devices')
      .where('activation_code', '=', activationCode)
      .where('active', '=', false)
      .set({
        hash,
        active: true,
        activation_code: null,
        expiry: null,
      })
      .returning(['uid', 'name'])
      .executeTakeFirst();
  }

  /**
   * Resets a device to unactivated state: clears `hash` and `active`, then sets a new activation code and expiry.
   * @param deviceUid The device to reregister.
   * @param activationCode The new one-time activation code.
   * @param expiry The expiry timestamp for the new code.
   * @returns The updated device row, or `undefined` if the device does not exist.
   */
  async reregister(deviceUid: string, activationCode: string, expiry: Date) {
    return await this._dbClient.db
      .updateTable('devices')
      .where('uid', '=', deviceUid)
      .set({
        hash: null,
        active: false,
        activation_code: activationCode,
        expiry,
      })
      .returning(['uid', 'activation_code', 'expiry'])
      .executeTakeFirst();
  }

  /**
   * Updates mutable device fields. Falls back to `findById` when no fields are provided.
   * @param deviceUid The device to update.
   * @param data Fields to update; omit any field to leave it unchanged.
   * @returns The updated device with room membership fields, or `undefined` if the device does not exist.
   */
  async update(deviceUid: string, data: { name?: string }) {
    if (data.name === undefined) {
      return this.findById(deviceUid);
    }

    const result = await this._dbClient.db
      .updateTable('devices')
      .where('uid', '=', deviceUid)
      .set({ name: data.name })
      .returning('uid')
      .executeTakeFirst();

    if (!result) return undefined;
    return this.findById(deviceUid);
  }

  /**
   * Stamps when a device was last heard from.
   *
   * Deliberately not routed through `update`: this runs on device-authenticated
   * requests rather than admin ones, writes a column no admin can set, and must
   * not re-read the row afterwards - it is called on a request path, and the
   * caller does not use the result.
   * @param deviceUid The device that was just seen.
   * @param seenAt Timestamp to record.
   */
  async updateLastSeenAt(deviceUid: string, seenAt: Date) {
    await this._dbClient.db
      .updateTable('devices')
      .where('uid', '=', deviceUid)
      .set({ last_seen_at: seenAt })
      .execute();
  }

  /**
   * Deletes a device by UID.
   * @param deviceUid The device to delete.
   * @returns `true` if a row was deleted, `false` if the device did not exist.
   */
  async delete(deviceUid: string): Promise<boolean> {
    const result = await this._dbClient.db
      .deleteFrom('devices')
      .where('uid', '=', deviceUid)
      .returning('uid')
      .executeTakeFirst();

    return result !== undefined;
  }
}
