import { type Updateable, sql } from 'kysely';

import type { JsonValue, Rooms } from '@scribear/scribear-db';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { decodeCursor, encodeCursor } from '#src/server/utils/pagination.js';

interface RoomRow {
  uid: string;
  name: string;
  timezone: string;
  auto_session_enabled: boolean;
  auto_session_transcription_provider_id: string | null;
  auto_session_transcription_stream_config: unknown;
  room_schedule_version: string;
  created_at: Date;
}

function mapRoom(row: RoomRow) {
  return {
    uid: row.uid,
    name: row.name,
    timezone: row.timezone,
    autoSessionEnabled: row.auto_session_enabled,
    autoSessionTranscriptionProviderId:
      row.auto_session_transcription_provider_id,
    autoSessionTranscriptionStreamConfig:
      row.auto_session_transcription_stream_config,
    roomScheduleVersion: Number(row.room_schedule_version),
    createdAt: row.created_at.toISOString(),
  };
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
        'auto_session_transcription_provider_id',
        'auto_session_transcription_stream_config',
        'room_schedule_version',
        'created_at',
      ])
      .where('uid', '=', roomUid)
      .executeTakeFirst();

    return row ? mapRoom(row as RoomRow) : undefined;
  }

  /**
   * Lists rooms with optional text search and cursor-based pagination.
   * @param params.search Case-insensitive name filter.
   * @param params.cursor Opaque cursor from a previous response's `nextCursor` field.
   * @param params.limit Maximum number of items to return.
   */
  async list(params: { search?: string; cursor?: string; limit: number }) {
    const { search, cursor: cursorStr, limit } = params;
    const cursor = cursorStr ? decodeCursor(cursorStr) : null;

    let query = this._dbClient.db
      .selectFrom('rooms')
      .select([
        'uid',
        'name',
        'timezone',
        'auto_session_enabled',
        'auto_session_transcription_provider_id',
        'auto_session_transcription_stream_config',
        'room_schedule_version',
        'created_at',
      ]);

    if (search !== undefined) {
      query = query.where('name', 'ilike', `%${search}%`);
    }

    if (cursor) {
      const cursorTs = new Date(cursor.createdAt);
      query = query.where((eb) =>
        eb.or([
          eb(sql`date_trunc('milliseconds', created_at)`, '>', cursorTs),
          eb.and([
            eb(sql`date_trunc('milliseconds', created_at)`, '=', cursorTs),
            eb('uid', '>', cursor.uid),
          ]),
        ]),
      );
    }

    const rows = (await query
      .orderBy('created_at', 'asc')
      .orderBy('uid', 'asc')
      .limit(limit + 1)
      .execute()) as RoomRow[];

    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const lastItem = items.at(-1);
    const nextCursor =
      hasMore && lastItem
        ? encodeCursor(lastItem.created_at, lastItem.uid)
        : undefined;

    return { items: items.map(mapRoom), nextCursor };
  }

  /**
   * Inserts a new room.
   * @param data.name The display name for the room.
   * @param data.timezone A valid IANA timezone identifier.
   * @param data.autoSessionEnabled Whether to enable automatic session creation.
   * @param data.autoSessionTranscriptionProviderId Optional transcription provider for auto-sessions.
   * @param data.autoSessionTranscriptionStreamConfig Optional provider-specific stream config.
   * @returns The newly created room.
   */
  async create(data: {
    name: string;
    timezone: string;
    autoSessionEnabled: boolean;
    autoSessionTranscriptionProviderId?: string | null;
    autoSessionTranscriptionStreamConfig?: unknown;
  }) {
    const row = (await this._dbClient.db
      .insertInto('rooms')
      .values({
        name: data.name,
        timezone: data.timezone,
        auto_session_enabled: data.autoSessionEnabled,
        auto_session_transcription_provider_id:
          data.autoSessionTranscriptionProviderId ?? null,
        auto_session_transcription_stream_config:
          (data.autoSessionTranscriptionStreamConfig ??
            null) as JsonValue | null,
      })
      .returning([
        'uid',
        'name',
        'timezone',
        'auto_session_enabled',
        'auto_session_transcription_provider_id',
        'auto_session_transcription_stream_config',
        'room_schedule_version',
        'created_at',
      ])
      .executeTakeFirstOrThrow()) as RoomRow;

    return mapRoom(row);
  }

  /**
   * Updates a room's fields. Returns the current state via `findById` when no fields are provided.
   * @param roomUid The room to update.
   * @param data Fields to update; any omitted field is left unchanged.
   */
  async update(
    roomUid: string,
    data: {
      name?: string;
      timezone?: string;
      autoSessionEnabled?: boolean;
      autoSessionTranscriptionProviderId?: string | null;
      autoSessionTranscriptionStreamConfig?: unknown;
    },
  ) {
    const updates: Partial<Updateable<Rooms>> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.timezone !== undefined) updates.timezone = data.timezone;
    if (data.autoSessionEnabled !== undefined)
      updates.auto_session_enabled = data.autoSessionEnabled;
    if ('autoSessionTranscriptionProviderId' in data)
      updates.auto_session_transcription_provider_id =
        data.autoSessionTranscriptionProviderId ?? null;
    if ('autoSessionTranscriptionStreamConfig' in data)
      updates.auto_session_transcription_stream_config =
        (data.autoSessionTranscriptionStreamConfig ?? null) as JsonValue | null;

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
        'auto_session_transcription_provider_id',
        'auto_session_transcription_stream_config',
        'room_schedule_version',
        'created_at',
      ])
      .executeTakeFirst();

    return row ? mapRoom(row as RoomRow) : undefined;
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
