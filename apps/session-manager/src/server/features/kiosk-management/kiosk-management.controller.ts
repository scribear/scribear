import {
  type BaseFastifyReply,
  type BaseFastifyRequest,
  HttpError,
} from '@scribear/base-fastify-server';
import type { REGISTER_KIOSK_SCHEMA } from '@scribear/session-manager-schema';

import type { AppDependencies } from '../../dependency-injection/register-dependencies.js';

export class KioskManagementController {
  private _kioskManagementService: AppDependencies['kioskManagementService'];

  constructor(
    kioskManagementService: AppDependencies['kioskManagementService'],
  ) {
    this._kioskManagementService = kioskManagementService;
  }

  async registerKiosk(
    req: BaseFastifyRequest<typeof REGISTER_KIOSK_SCHEMA>,
    res: BaseFastifyReply<typeof REGISTER_KIOSK_SCHEMA>,
  ) {
    const result = await this._kioskManagementService.createKiosk();
    if (result === null) {
      throw new HttpError.ServerError('Failed to create new kiosk entry.');
    }

    res.code(200).send(result);
  }
}
