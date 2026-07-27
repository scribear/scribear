import {
  type BaseFastifyReply,
  type BaseFastifyRequest,
  HttpError,
} from '@scribear/base-fastify-server';
import {
  ACTIVATE_DEVICE_SCHEMA,
  DELETE_DEVICE_SCHEMA,
  DEVICE_TOKEN_COOKIE_NAME,
  GET_DEVICE_SCHEMA,
  GET_MY_DEVICE_SCHEMA,
  LIST_DEVICES_SCHEMA,
  REGISTER_DEVICE_SCHEMA,
  REREGISTER_DEVICE_SCHEMA,
  UPDATE_DEVICE_SCHEMA,
} from '@scribear/session-manager-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Refusals for mutating the demo caption room's placeholder source device.
 * 409, matching the sibling `WOULD_LEAVE_ROOM_WITHOUT_SOURCE` refusal on the
 * same endpoint: the device exists and the request is well formed, it just
 * conflicts with the device's role as a fixed placeholder the demo room
 * requires.
 */
const DEMO_SOURCE_DEVICE_NOT_DELETABLE_MESSAGE =
  "That is the demo caption room's placeholder source device — deleting it " +
  'would strand the demo room without a source until the next restart, and ' +
  'nothing else can be attached in its place (the room refuses every other ' +
  'device). To remove the feature, disable DEMO_ROOM_ENABLED instead.';

const DEMO_SOURCE_DEVICE_NOT_REREGISTRABLE_MESSAGE =
  "That is the demo caption room's placeholder source device — it is " +
  'deliberately never activated and nobody holds its activation code. ' +
  'Re-registering it would mint a fresh code for a row that exists only to ' +
  "satisfy the room's source-device requirement, letting some physical " +
  'device claim its identity for no benefit, since it can never be attached ' +
  'anywhere else.';

export class DeviceManagementController {
  private _useSecureCookie: boolean;
  private _deviceManagementService: AppDependencies['deviceManagementService'];
  private _deviceAuthService: AppDependencies['deviceAuthService'];
  private _devicePresenceService: AppDependencies['devicePresenceService'];

  constructor(
    baseConfig: AppDependencies['baseConfig'],
    deviceManagementService: AppDependencies['deviceManagementService'],
    deviceAuthService: AppDependencies['deviceAuthService'],
    devicePresenceService: AppDependencies['devicePresenceService'],
  ) {
    this._useSecureCookie = !baseConfig.isDevelopment;
    this._deviceManagementService = deviceManagementService;
    this._deviceAuthService = deviceAuthService;
    this._devicePresenceService = devicePresenceService;
  }

  /**
   * Adds the wire representation of presence to a device.
   *
   * `online` is derived here rather than in the SPA so every consumer — admin
   * console, fleet view, any future caller — agrees on one cutoff instead of
   * each inventing its own.
   */
  private _withPresence<T extends { createdAt: Date; lastSeenAt: Date | null }>(
    device: T,
  ) {
    return {
      ...device,
      createdAt: device.createdAt.toISOString(),
      lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      online: this._devicePresenceService.isOnline(device.lastSeenAt),
    };
  }

  async listDevices(
    req: BaseFastifyRequest<typeof LIST_DEVICES_SCHEMA>,
    res: BaseFastifyReply<typeof LIST_DEVICES_SCHEMA>,
  ) {
    const { active, search, roomUid, cursor, limit = 50 } = req.query;

    const result = await this._deviceManagementService.listDevices({
      search: search ?? null,
      active: active ?? null,
      roomUid: roomUid ?? null,
      cursor: cursor ?? null,
      limit,
    });

    res.code(200).send({
      items: result.items.map((device) => this._withPresence(device)),
      nextCursor: result.nextCursor,
    });
  }

  async getDevice(
    req: BaseFastifyRequest<typeof GET_DEVICE_SCHEMA>,
    res: BaseFastifyReply<typeof GET_DEVICE_SCHEMA>,
  ) {
    const result = await this._deviceManagementService.getDevice(
      req.params.deviceUid,
    );
    if (result === 'DEVICE_NOT_FOUND') {
      throw HttpError.notFound('DEVICE_NOT_FOUND', 'Device not found.');
    }

    res.code(200).send(this._withPresence(result));
  }

  async registerDevice(
    req: BaseFastifyRequest<typeof REGISTER_DEVICE_SCHEMA>,
    res: BaseFastifyReply<typeof REGISTER_DEVICE_SCHEMA>,
  ) {
    const result = await this._deviceManagementService.registerDevice(
      req.body.name,
    );

    res.code(201).send({
      deviceUid: result.deviceUid,
      activationCode: result.activationCode,
      expiry: result.expiry.toISOString(),
    });
  }

  async reregisterDevice(
    req: BaseFastifyRequest<typeof REREGISTER_DEVICE_SCHEMA>,
    res: BaseFastifyReply<typeof REREGISTER_DEVICE_SCHEMA>,
  ) {
    const result = await this._deviceManagementService.reregisterDevice(
      req.body.deviceUid,
    );
    if (result === 'DEMO_SOURCE_DEVICE_NOT_REREGISTRABLE') {
      throw HttpError.conflict(
        'DEMO_SOURCE_DEVICE_NOT_REREGISTRABLE',
        DEMO_SOURCE_DEVICE_NOT_REREGISTRABLE_MESSAGE,
      );
    }
    if (result === 'DEVICE_NOT_FOUND') {
      throw HttpError.notFound('DEVICE_NOT_FOUND', 'Device not found.');
    }

    // The device is going back to pending, so its old presence clock must not
    // suppress the write on its first request after re-activation.
    this._devicePresenceService.forget(req.body.deviceUid);

    res.code(200).send({
      activationCode: result.activationCode,
      expiry: result.expiry.toISOString(),
    });
  }

  async activateDevice(
    req: BaseFastifyRequest<typeof ACTIVATE_DEVICE_SCHEMA>,
    res: BaseFastifyReply<typeof ACTIVATE_DEVICE_SCHEMA>,
  ) {
    const result = await this._deviceManagementService.activateDevice(
      req.body.activationCode,
    );
    if (result === 'ACTIVATION_CODE_NOT_FOUND') {
      throw HttpError.notFound(
        'ACTIVATION_CODE_NOT_FOUND',
        'Activation code not found.',
      );
    }
    if (result === 'ACTIVATION_CODE_EXPIRED') {
      throw HttpError.gone(
        'ACTIVATION_CODE_EXPIRED',
        'Activation code has expired.',
      );
    }

    const cookieValue = this._deviceAuthService.encode(
      result.deviceUid,
      result.secret,
    );
    res.setCookie(DEVICE_TOKEN_COOKIE_NAME, cookieValue, {
      httpOnly: true,
      path: '/',
      secure: this._useSecureCookie,
      sameSite: 'strict',
      maxAge: COOKIE_MAX_AGE_SECONDS,
    });

    res.code(200).send({ deviceUid: result.deviceUid });
  }

  async updateDevice(
    req: BaseFastifyRequest<typeof UPDATE_DEVICE_SCHEMA>,
    res: BaseFastifyReply<typeof UPDATE_DEVICE_SCHEMA>,
  ) {
    const { deviceUid, ...updates } = req.body;

    const result = await this._deviceManagementService.updateDevice(
      deviceUid,
      updates,
    );
    if (result === 'DEVICE_NOT_FOUND') {
      throw HttpError.notFound('DEVICE_NOT_FOUND', 'Device not found.');
    }

    res.code(200).send(this._withPresence(result));
  }

  async deleteDevice(
    req: BaseFastifyRequest<typeof DELETE_DEVICE_SCHEMA>,
    res: BaseFastifyReply<typeof DELETE_DEVICE_SCHEMA>,
  ) {
    const result = await this._deviceManagementService.deleteDevice(
      req.body.deviceUid,
    );
    if (result === 'DEMO_SOURCE_DEVICE_NOT_DELETABLE') {
      throw HttpError.conflict(
        'DEMO_SOURCE_DEVICE_NOT_DELETABLE',
        DEMO_SOURCE_DEVICE_NOT_DELETABLE_MESSAGE,
      );
    }
    if (result === 'DEVICE_NOT_FOUND') {
      throw HttpError.notFound('DEVICE_NOT_FOUND', 'Device not found.');
    }
    if (result === 'WOULD_LEAVE_ROOM_WITHOUT_SOURCE') {
      throw HttpError.conflict(
        'WOULD_LEAVE_ROOM_WITHOUT_SOURCE',
        'Cannot delete the source device of a room. Assign a new source first.',
      );
    }

    // Otherwise the uid's write clock would linger in memory for the lifetime
    // of the process, for a device that no longer exists.
    this._devicePresenceService.forget(req.body.deviceUid);

    res.code(204).send(null);
  }

  async getMyDevice(
    req: BaseFastifyRequest<typeof GET_MY_DEVICE_SCHEMA>,
    res: BaseFastifyReply<typeof GET_MY_DEVICE_SCHEMA>,
  ) {
    if (!req.deviceUid) throw HttpError.internal();

    const result = await this._deviceManagementService.getMyDevice(
      req.deviceUid,
    );
    if (result === 'DEVICE_NOT_FOUND') {
      throw HttpError.notFound('DEVICE_NOT_FOUND', 'Device not found.');
    }

    res.code(200).send(result);
  }
}
