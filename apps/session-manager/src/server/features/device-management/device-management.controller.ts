import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import { HttpError } from '@scribear/base-fastify-server';
import {
  ACTIVATE_DEVICE_SCHEMA,
  REGISTER_DEVICE_SCHEMA,
} from '@scribear/session-manager-schema';

import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';

export class DeviceManagementController {
  private _useSecureCookie: boolean;
  private _deviceManagementService: AppDependencies['deviceManagementService'];
  private _authService: AppDependencies['authService'];

  constructor(
    baseConfig: AppDependencies['baseConfig'],
    deviceManagementService: AppDependencies['deviceManagementService'],
    authService: AppDependencies['authService'],
  ) {
    this._useSecureCookie = !baseConfig.isDevelopment;
    this._deviceManagementService = deviceManagementService;
    this._authService = authService;
  }

  async registerDevice(
    req: BaseFastifyRequest<typeof REGISTER_DEVICE_SCHEMA>,
    res: BaseFastifyReply<typeof REGISTER_DEVICE_SCHEMA>,
  ) {
    const { deviceName } = req.body;

    const { deviceId, activationCode } =
      await this._deviceManagementService.registerDevice(deviceName);

    res.code(200).send({ deviceId, activationCode });
  }

  async activateDevice(
    req: BaseFastifyRequest<typeof ACTIVATE_DEVICE_SCHEMA>,
    res: BaseFastifyReply<typeof ACTIVATE_DEVICE_SCHEMA>,
  ) {
    const { activationCode } = req.body;

    const result =
      await this._deviceManagementService.activateDevice(activationCode);
    if (!result) {
      throw new HttpError.BadRequest([
        {
          key: 'activationCode',
          message: 'Invalid or expired activation code.',
        },
      ]);
    }

    const cookieValue = this._authService.encodeDeviceToken(
      result.deviceId,
      result.deviceSecret,
    );
    res.setCookie('device_token', cookieValue, {
      httpOnly: true,
      path: '/',
      secure: this._useSecureCookie,
      sameSite: 'strict',
    });
    res
      .code(200)
      .send({ deviceId: result.deviceId, deviceName: result.deviceName });
  }
}
