import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

const VALID_TIMEZONES = new Set(Intl.supportedValuesOf('timeZone'));

function isValidTimezone(tz: string): boolean {
  return VALID_TIMEZONES.has(tz);
}

export class RoomManagementService {
  private _log: AppDependencies['logger'];
  private _roomManagementRepository: AppDependencies['roomManagementRepository'];
  private _deviceManagementRepository: AppDependencies['deviceManagementRepository'];

  constructor(
    logger: AppDependencies['logger'],
    roomManagementRepository: AppDependencies['roomManagementRepository'],
    deviceManagementRepository: AppDependencies['deviceManagementRepository'],
  ) {
    this._log = logger;
    this._roomManagementRepository = roomManagementRepository;
    this._deviceManagementRepository = deviceManagementRepository;
  }

  /**
   * Lists rooms with optional text search and cursor-based pagination.
   * @param params.search Case-insensitive name filter.
   * @param params.cursor Opaque cursor from a previous response's `nextCursor` field.
   * @param params.limit Maximum number of items to return.
   */
  async listRooms(params: { search?: string; cursor?: string; limit: number }) {
    return this._roomManagementRepository.list(params);
  }

  /**
   * Fetches a single room by UID.
   * @param roomUid The room's unique identifier.
   * @returns The room, or `'ROOM_NOT_FOUND'` if no matching room exists.
   */
  async getRoom(roomUid: string) {
    const room = await this._roomManagementRepository.findById(roomUid);
    return room ?? 'ROOM_NOT_FOUND';
  }

  /**
   * Validates the timezone against the IANA list and requires exactly one source device.
   * The source device must not already belong to another room.
   * @param data.timezone Must be a valid IANA timezone identifier.
   * @param data.sourceDeviceUids Must contain exactly one UID; that device must not already be in a room.
   */
  async createRoom(data: {
    name: string;
    timezone: string;
    autoSessionEnabled?: boolean;
    autoSessionTranscriptionProviderId?: string | null;
    autoSessionTranscriptionStreamConfig?: unknown;
    sourceDeviceUids: string[];
  }) {
    if (!isValidTimezone(data.timezone)) {
      return 'INVALID_TIMEZONE';
    }

    if (data.sourceDeviceUids.length > 1) {
      return 'TOO_MANY_SOURCE_DEVICES';
    }

    const sourceDeviceUid = data.sourceDeviceUids[0];
    if (sourceDeviceUid === undefined) {
      return 'NO_SOURCE_DEVICE';
    }

    const device =
      await this._deviceManagementRepository.findById(sourceDeviceUid);
    if (!device) {
      return 'DEVICE_NOT_FOUND';
    }
    if (device.roomUid !== null) {
      return 'DEVICE_ALREADY_IN_ROOM';
    }

    const room = await this._roomManagementRepository.create({
      name: data.name,
      timezone: data.timezone,
      autoSessionEnabled: data.autoSessionEnabled ?? false,
      ...(data.autoSessionTranscriptionProviderId !== undefined && {
        autoSessionTranscriptionProviderId:
          data.autoSessionTranscriptionProviderId,
      }),
      ...(data.autoSessionTranscriptionStreamConfig !== undefined && {
        autoSessionTranscriptionStreamConfig:
          data.autoSessionTranscriptionStreamConfig,
      }),
    });

    await this._roomManagementRepository.addDeviceToRoom(
      room.uid,
      sourceDeviceUid,
      true,
    );

    this._log.info({ roomUid: room.uid }, 'Room created');
    return room;
  }

  /**
   * Updates mutable fields on a room. Validates the timezone if provided.
   * @param roomUid The room to update.
   * @param data Fields to update; omit any field to leave it unchanged.
   * @returns The updated room, `'ROOM_NOT_FOUND'`, or `'INVALID_TIMEZONE'` for a bad timezone value.
   */
  async updateRoom(
    roomUid: string,
    data: {
      name?: string;
      timezone?: string;
      autoSessionEnabled?: boolean;
      autoSessionTranscriptionProviderId?: string | null;
      autoSessionTranscriptionStreamConfig?: unknown;
    },
  ) {
    if (data.timezone !== undefined && !isValidTimezone(data.timezone)) {
      return 'INVALID_TIMEZONE';
    }

    const room = await this._roomManagementRepository.update(roomUid, data);
    return room ?? 'ROOM_NOT_FOUND';
  }

  /**
   * Deletes a room by UID.
   * @param roomUid The room to delete.
   * @returns `undefined` on success, or `'ROOM_NOT_FOUND'` if the room does not exist.
   */
  async deleteRoom(roomUid: string) {
    const deleted = await this._roomManagementRepository.delete(roomUid);
    if (!deleted) return 'ROOM_NOT_FOUND';
    return;
  }

  /**
   * Adds a device to a room as either a source or non-source member.
   * @param params.roomUid The room to add the device to.
   * @param params.deviceUid The device to add; must not already be in a room.
   * @param params.asSource Whether to designate this device as the room's source.
   * @returns `undefined` on success, or an error code: `'ROOM_NOT_FOUND'`, `'DEVICE_NOT_FOUND'`, or `'DEVICE_ALREADY_IN_ROOM'`.
   */
  async addDeviceToRoom(params: {
    roomUid: string;
    deviceUid: string;
    asSource: boolean;
  }) {
    const [roomExists, device] = await Promise.all([
      this._roomManagementRepository.findRoomExists(params.roomUid),
      this._deviceManagementRepository.findById(params.deviceUid),
    ]);

    if (!roomExists) return 'ROOM_NOT_FOUND';
    if (!device) return 'DEVICE_NOT_FOUND';
    if (device.roomUid !== null) return 'DEVICE_ALREADY_IN_ROOM';

    await this._roomManagementRepository.addDeviceToRoom(
      params.roomUid,
      params.deviceUid,
      params.asSource,
    );
    return;
  }

  /**
   * Removes a device from whichever room it belongs to.
   * @param deviceUid The device to remove.
   * @returns `WOULD_LEAVE_ROOM_WITHOUT_SOURCE` if the device is the room's current source.
   */
  async removeDeviceFromRoom(deviceUid: string) {
    const membership =
      await this._roomManagementRepository.findRoomMembership(deviceUid);
    if (!membership) return 'MEMBERSHIP_NOT_FOUND';
    if (membership.is_source) return 'WOULD_LEAVE_ROOM_WITHOUT_SOURCE';

    await this._roomManagementRepository.removeDeviceFromRoom(deviceUid);
    return;
  }

  /**
   * Promotes a device to source within a room. The device must already be a member.
   * @param roomUid The room to update.
   * @param deviceUid The device to promote; must already be a member of the room.
   * @returns `DEVICE_NOT_IN_ROOM` if the device is not a current member.
   */
  async setSourceDevice(roomUid: string, deviceUid: string) {
    const roomExists =
      await this._roomManagementRepository.findRoomExists(roomUid);
    if (!roomExists) return 'ROOM_NOT_FOUND';

    const updated = await this._roomManagementRepository.setSourceDevice(
      roomUid,
      deviceUid,
    );
    if (!updated) return 'DEVICE_NOT_IN_ROOM';
    return;
  }

  /**
   * Returns the room a device belongs to, looked up by device UID.
   * @param deviceUid The authenticated device's unique identifier.
   * @returns The room, or `'DEVICE_NOT_IN_ROOM'` if the device is not a member of any room.
   */
  async getMyRoom(deviceUid: string) {
    const membership =
      await this._roomManagementRepository.findRoomMembership(deviceUid);
    if (!membership) return 'DEVICE_NOT_IN_ROOM';

    const room = await this._roomManagementRepository.findById(
      membership.room_uid,
    );
    return room ?? 'DEVICE_NOT_IN_ROOM';
  }
}
