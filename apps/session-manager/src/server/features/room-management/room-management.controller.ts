import {
  type BaseFastifyReply,
  type BaseFastifyRequest,
  HttpError,
} from '@scribear/base-fastify-server';
import {
  ADD_DEVICE_TO_ROOM_SCHEMA,
  CREATE_ROOM_SCHEMA,
  DELETE_ROOM_SCHEMA,
  GET_MY_ROOM_SCHEMA,
  GET_ROOM_SCHEMA,
  LIST_ROOMS_SCHEMA,
  REMOVE_DEVICE_FROM_ROOM_SCHEMA,
  SET_SOURCE_DEVICE_SCHEMA,
  UPDATE_ROOM_SCHEMA,
} from '@scribear/session-manager-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

export class RoomManagementController {
  private _roomManagementService: AppDependencies['roomManagementService'];

  constructor(roomManagementService: AppDependencies['roomManagementService']) {
    this._roomManagementService = roomManagementService;
  }

  async listRooms(
    req: BaseFastifyRequest<typeof LIST_ROOMS_SCHEMA>,
    res: BaseFastifyReply<typeof LIST_ROOMS_SCHEMA>,
  ) {
    const { search, cursor, limit = 50 } = req.query;

    const result = await this._roomManagementService.listRooms({
      ...(search !== undefined && { search }),
      ...(cursor !== undefined && { cursor }),
      limit,
    });

    res.code(200).send({
      items: result.items,
      ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor }),
    });
  }

  async getRoom(
    req: BaseFastifyRequest<typeof GET_ROOM_SCHEMA>,
    res: BaseFastifyReply<typeof GET_ROOM_SCHEMA>,
  ) {
    const result = await this._roomManagementService.getRoom(
      req.params.roomUid,
    );
    if (result === 'ROOM_NOT_FOUND') {
      throw HttpError.notFound('ROOM_NOT_FOUND', 'Room not found.');
    }

    res.code(200).send(result);
  }

  async createRoom(
    req: BaseFastifyRequest<typeof CREATE_ROOM_SCHEMA>,
    res: BaseFastifyReply<typeof CREATE_ROOM_SCHEMA>,
  ) {
    const result = await this._roomManagementService.createRoom(req.body);
    if (result === 'INVALID_TIMEZONE') {
      throw HttpError.unprocessable(
        'INVALID_TIMEZONE',
        'Invalid IANA timezone identifier.',
      );
    }
    if (result === 'TOO_MANY_SOURCE_DEVICES') {
      throw HttpError.conflict(
        'TOO_MANY_SOURCE_DEVICES',
        'Currently only one source device per room is allowed.',
      );
    }
    if (result === 'NO_SOURCE_DEVICE') {
      throw HttpError.unprocessable(
        'NO_SOURCE_DEVICE',
        'At least one source device is required.',
      );
    }
    if (result === 'DEVICE_NOT_FOUND') {
      throw HttpError.notFound('DEVICE_NOT_FOUND', 'Source device not found.');
    }
    if (result === 'DEVICE_ALREADY_IN_ROOM') {
      throw HttpError.conflict(
        'DEVICE_ALREADY_IN_ROOM',
        'Device is already a member of a room.',
      );
    }

    res.code(201).send(result);
  }

  async updateRoom(
    req: BaseFastifyRequest<typeof UPDATE_ROOM_SCHEMA>,
    res: BaseFastifyReply<typeof UPDATE_ROOM_SCHEMA>,
  ) {
    const { roomUid, ...updates } = req.body;

    const result = await this._roomManagementService.updateRoom(
      roomUid,
      updates,
    );
    if (result === 'INVALID_TIMEZONE') {
      throw HttpError.unprocessable(
        'INVALID_TIMEZONE',
        'Invalid IANA timezone identifier.',
      );
    }
    if (result === 'ROOM_NOT_FOUND') {
      throw HttpError.notFound('ROOM_NOT_FOUND', 'Room not found.');
    }

    res.code(200).send(result);
  }

  async deleteRoom(
    req: BaseFastifyRequest<typeof DELETE_ROOM_SCHEMA>,
    res: BaseFastifyReply<typeof DELETE_ROOM_SCHEMA>,
  ) {
    const result = await this._roomManagementService.deleteRoom(
      req.body.roomUid,
    );
    if (result === 'ROOM_NOT_FOUND') {
      throw HttpError.notFound('ROOM_NOT_FOUND', 'Room not found.');
    }

    res.code(204).send(null);
  }

  async addDeviceToRoom(
    req: BaseFastifyRequest<typeof ADD_DEVICE_TO_ROOM_SCHEMA>,
    res: BaseFastifyReply<typeof ADD_DEVICE_TO_ROOM_SCHEMA>,
  ) {
    const { roomUid, deviceUid, asSource = false } = req.body;

    const result = await this._roomManagementService.addDeviceToRoom({
      roomUid,
      deviceUid,
      asSource,
    });
    if (result === 'ROOM_NOT_FOUND') {
      throw HttpError.notFound('ROOM_NOT_FOUND', 'Room not found.');
    }
    if (result === 'DEVICE_NOT_FOUND') {
      throw HttpError.notFound('DEVICE_NOT_FOUND', 'Device not found.');
    }
    if (result === 'DEVICE_ALREADY_IN_ROOM') {
      throw HttpError.conflict(
        'DEVICE_ALREADY_IN_ROOM',
        'Device is already a member of a room.',
      );
    }

    res.code(204).send(null);
  }

  async removeDeviceFromRoom(
    req: BaseFastifyRequest<typeof REMOVE_DEVICE_FROM_ROOM_SCHEMA>,
    res: BaseFastifyReply<typeof REMOVE_DEVICE_FROM_ROOM_SCHEMA>,
  ) {
    const result = await this._roomManagementService.removeDeviceFromRoom(
      req.body.deviceUid,
    );
    if (result === 'MEMBERSHIP_NOT_FOUND') {
      throw HttpError.notFound(
        'MEMBERSHIP_NOT_FOUND',
        'Device is not a member of any room.',
      );
    }
    if (result === 'WOULD_LEAVE_ROOM_WITHOUT_SOURCE') {
      throw HttpError.conflict(
        'WOULD_LEAVE_ROOM_WITHOUT_SOURCE',
        'Cannot remove the source device from the room. Assign a new source device first.',
      );
    }

    res.code(204).send(null);
  }

  async setSourceDevice(
    req: BaseFastifyRequest<typeof SET_SOURCE_DEVICE_SCHEMA>,
    res: BaseFastifyReply<typeof SET_SOURCE_DEVICE_SCHEMA>,
  ) {
    const { roomUid, deviceUid } = req.body;

    const result = await this._roomManagementService.setSourceDevice(
      roomUid,
      deviceUid,
    );
    if (result === 'ROOM_NOT_FOUND') {
      throw HttpError.notFound('ROOM_NOT_FOUND', 'Room not found.');
    }
    if (result === 'DEVICE_NOT_IN_ROOM') {
      throw HttpError.notFound(
        'DEVICE_NOT_IN_ROOM',
        'Device is not a member of the specified room.',
      );
    }

    res.code(204).send(null);
  }

  async getMyRoom(
    req: BaseFastifyRequest<typeof GET_MY_ROOM_SCHEMA>,
    res: BaseFastifyReply<typeof GET_MY_ROOM_SCHEMA>,
  ) {
    const result = await this._roomManagementService.getMyRoom(req.deviceUid);
    if (result === 'DEVICE_NOT_IN_ROOM') {
      throw HttpError.notFound(
        'DEVICE_NOT_IN_ROOM',
        'Device is not a member of any room.',
      );
    }

    res.code(200).send(result);
  }
}
