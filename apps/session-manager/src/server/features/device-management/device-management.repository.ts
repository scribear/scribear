import { sql } from 'kysely';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { decodeCursor, encodeCursor } from '#src/server/utils/pagination.js';

interface DeviceRow {
  uid: string;
  name: string;
  active: boolean;
  created_at: Date;
  room_uid: string | null;
  is_source: boolean | null;
}

function mapDevice(row: DeviceRow) {
  return {
    uid: row.uid,
    name: row.name,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    roomUid: row.room_uid,
    isSource: row.is_source,
  };
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
        'room_devices.room_uid',
        'room_devices.is_source',
      ])
      .where('devices.uid', '=', deviceUid)
      .executeTakeFirst();

    return row ? mapDevice(row as DeviceRow) : undefined;
  }

  /**
   * Lists devices with optional filtering and cursor-based pagination.
   * Pass undefined for any filter to disable that filter.
   * @param params.search Filter by fuzzy name match.
   * @param params.active Filter by activation state.
   * @param params.roomUid Filter by room membership, pass `''` to return only devices not in any room.
   * @param params.cursor Opaque cursor from a previous response's `nextCursor` field, undefined for first page.
   * @param params.limit Maximum number of items to return.
   */
  async list(params: {
    search?: string;
    active?: boolean;
    roomUid?: string;
    cursor?: string;
    limit: number;
  }) {
    const { search, active, roomUid, cursor: cursorStr, limit } = params;

    const cursor = cursorStr ? decodeCursor(cursorStr) : null;

    let query = this._dbClient.db
      .selectFrom('devices')
      .leftJoin('room_devices', 'room_devices.device_uid', 'devices.uid')
      .select([
        'devices.uid',
        'devices.name',
        'devices.active',
        'devices.created_at',
        'room_devices.room_uid',
        'room_devices.is_source',
      ]);

    if (search !== undefined) {
      query = query.where('devices.name', 'ilike', `%${search}%`);
    }
    if (active !== undefined) {
      query = query.where('devices.active', '=', active);
    }
    if (roomUid !== undefined) {
      if (roomUid === '') {
        query = query.where('room_devices.device_uid', 'is', null);
      } else {
        query = query.where('room_devices.room_uid', '=', roomUid);
      }
    }

    if (cursor) {
      const cursorTs = new Date(cursor.createdAt);
      query = query.where((eb) =>
        eb.or([
          eb(sql`date_trunc('milliseconds', devices.created_at)`, '>', cursorTs),
          eb.and([
            eb(sql`date_trunc('milliseconds', devices.created_at)`, '=', cursorTs),
            eb('devices.uid', '>', cursor.uid),
          ]),
        ]),
      );
    }

    const rows = (await query
      .orderBy('devices.created_at', 'asc')
      .orderBy('devices.uid', 'asc')
      .limit(limit + 1)
      .execute()) as DeviceRow[];

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const lastItem = items.at(-1);
    const nextCursor =
      hasMore && lastItem
        ? encodeCursor(lastItem.created_at, lastItem.uid)
        : undefined;

    return { items: items.map(mapDevice), nextCursor };
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
