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

/**
 * Refusals for the synthetic demo caption room. 409 rather than 422: the
 * request is well formed and the caller is not confused about the schema — it
 * conflicts with the state of a specific resource, exactly like the sibling
 * `DEVICE_ALREADY_IN_ROOM` / `WOULD_LEAVE_ROOM_WITHOUT_SOURCE` refusals. The
 * messages name the reason (no audio path) so an operator does not read this as
 * a transient failure to retry.
 */
const DEMO_ROOM_NOT_ASSIGNABLE_MESSAGE =
  'The demo caption room is a synthetic caption source with no audio path — ' +
  'its captions are published from a fixture, so a device attached to it ' +
  'would never be recorded or transcribed. Devices cannot be added to it or ' +
  'made its source device.';

const DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE_MESSAGE =
  "The demo caption room's placeholder source device is not a real device — " +
  'it is never activated and can never send audio, so it cannot be added to a ' +
  'room or made a room source device.';

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
      search: search ?? null,
      cursor: cursor ?? null,
      limit,
    });

    res.code(200).send({
      items: result.items.map((room) => {
        return {
          ...room,
          createdAt: room.createdAt.toISOString(),
        };
      }),
      nextCursor: result.nextCursor,
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

    res.code(200).send({
      ...result,
      createdAt: result.createdAt.toISOString(),
    });
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
    if (result === 'DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE') {
      throw HttpError.conflict(
        'DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE',
        DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE_MESSAGE,
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

    res.code(201).send({
      ...result,
      createdAt: result.createdAt.toISOString(),
    });
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
    if (result === 'ROOM_NOT_FOUND') {
      throw HttpError.notFound('ROOM_NOT_FOUND', 'Room not found.');
    }

    res.code(200).send({
      ...result,
      createdAt: result.createdAt.toISOString(),
    });
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
    const { roomUid, deviceUid, asSource } = req.body;

    const result = await this._roomManagementService.addDeviceToRoom({
      roomUid,
      deviceUid,
      asSource,
    });
    if (result === 'DEMO_ROOM_NOT_ASSIGNABLE') {
      throw HttpError.conflict(
        'DEMO_ROOM_NOT_ASSIGNABLE',
        DEMO_ROOM_NOT_ASSIGNABLE_MESSAGE,
      );
    }
    if (result === 'DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE') {
      throw HttpError.conflict(
        'DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE',
        DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE_MESSAGE,
      );
    }
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
    if (result === 'DEMO_ROOM_NOT_ASSIGNABLE') {
      throw HttpError.conflict(
        'DEMO_ROOM_NOT_ASSIGNABLE',
        DEMO_ROOM_NOT_ASSIGNABLE_MESSAGE,
      );
    }
    if (result === 'DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE') {
      throw HttpError.conflict(
        'DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE',
        DEMO_SOURCE_DEVICE_NOT_ASSIGNABLE_MESSAGE,
      );
    }
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
    if (!req.deviceUid) throw HttpError.internal();

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
