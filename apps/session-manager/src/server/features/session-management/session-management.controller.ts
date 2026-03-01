import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import { HttpError } from '@scribear/base-fastify-server';
import {
  CREATE_SESSION_SCHEMA,
  DEVICE_SESSION_EVENTS_SCHEMA,
} from '@scribear/session-manager-schema';

import type { AppDependencies } from '#src/server/dependency-injection/register-dependencies.js';

export class SessionManagementController {
  private _sessionManagementService: AppDependencies['sessionManagementService'];

  constructor(
    sessionManagementService: AppDependencies['sessionManagementService'],
  ) {
    this._sessionManagementService = sessionManagementService;
  }

  async createSession(
    req: BaseFastifyRequest<typeof CREATE_SESSION_SCHEMA>,
    res: BaseFastifyReply<typeof CREATE_SESSION_SCHEMA>,
  ) {
    const {
      sourceDeviceId,
      transcriptionProviderKey,
      transcriptionProviderConfig,
      endTimeUnixMs,
    } = req.body;

    const result = await this._sessionManagementService.createOnDemandSession(
      sourceDeviceId,
      transcriptionProviderKey,
      transcriptionProviderConfig,
      endTimeUnixMs,
    );

    if ('error' in result) {
      if (result.error === 'INVALID_END_TIME') {
        throw new HttpError.BadRequest([
          { key: 'endTimeUnixMs', message: 'End time must be in the future.' },
        ]);
      }
      throw new HttpError.BadRequest([
        { key: 'sourceDeviceId', message: 'Device not found.' },
      ]);
    }

    res.code(200).send({ sessionId: result.sessionId });
  }

  async getDeviceSessionEvents(
    req: BaseFastifyRequest<typeof DEVICE_SESSION_EVENTS_SCHEMA>,
    res: BaseFastifyReply<typeof DEVICE_SESSION_EVENTS_SCHEMA>,
  ) {
    const { prevEventId } = req.query;

    const event = await this._sessionManagementService.getDeviceSessionEvent(
      req.deviceId,
      prevEventId,
    );

    res.code(200).send(event ?? null);
  }
}
