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

export class DeviceManagementController {
  private _useSecureCookie: boolean;
  private _deviceManagementService: AppDependencies['deviceManagementService'];
  private _deviceAuthService: AppDependencies['deviceAuthService'];

  constructor(
    baseConfig: AppDependencies['baseConfig'],
    deviceManagementService: AppDependencies['deviceManagementService'],
    deviceAuthService: AppDependencies['deviceAuthService'],
  ) {
    this._useSecureCookie = !baseConfig.isDevelopment;
    this._deviceManagementService = deviceManagementService;
    this._deviceAuthService = deviceAuthService;
  }

  async listDevices(
    req: BaseFastifyRequest<typeof LIST_DEVICES_SCHEMA>,
    res: BaseFastifyReply<typeof LIST_DEVICES_SCHEMA>,
  ) {
    const { search, active, roomUid, cursor, limit = 50 } = req.query;

    const result = await this._deviceManagementService.listDevices({
      ...(search !== undefined && { search }),
      ...(active !== undefined && { active }),
      ...(roomUid !== undefined && { roomUid }),
      ...(cursor !== undefined && { cursor }),
      limit,
    });

    res.code(200).send({
      items: result.items,
      ...(result.nextCursor !== undefined && { nextCursor: result.nextCursor }),
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

    res.code(200).send(result);
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
    if (result === 'DEVICE_NOT_FOUND') {
      throw HttpError.notFound('DEVICE_NOT_FOUND', 'Device not found.');
    }

    res.code(200).send(result);
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

    res.code(200).send(result);
  }

  async deleteDevice(
    req: BaseFastifyRequest<typeof DELETE_DEVICE_SCHEMA>,
    res: BaseFastifyReply<typeof DELETE_DEVICE_SCHEMA>,
  ) {
    const result = await this._deviceManagementService.deleteDevice(
      req.body.deviceUid,
    );
    if (result === 'DEVICE_NOT_FOUND') {
      throw HttpError.notFound('DEVICE_NOT_FOUND', 'Device not found.');
    }
    if (result === 'WOULD_LEAVE_ROOM_WITHOUT_SOURCE') {
      throw HttpError.conflict(
        'WOULD_LEAVE_ROOM_WITHOUT_SOURCE',
        'Cannot delete the source device of a room. Assign a new source first.',
      );
    }

    res.code(204).send(null);
  }

  async getMyDevice(
    req: BaseFastifyRequest<typeof GET_MY_DEVICE_SCHEMA>,
    res: BaseFastifyReply<typeof GET_MY_DEVICE_SCHEMA>,
  ) {
    const result = await this._deviceManagementService.getMyDevice(
      req.deviceUid,
    );
    if (result === 'DEVICE_NOT_FOUND') {
      throw HttpError.notFound('DEVICE_NOT_FOUND', 'Device not found.');
    }

    res.code(200).send(result);
  }
}
