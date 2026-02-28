import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import { CREATE_SESSION_SCHEMA } from '@scribear/session-manager-schema';

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

    const { sessionId } =
      await this._sessionManagementService.createOnDemandSession(
        sourceDeviceId,
        transcriptionProviderKey,
        transcriptionProviderConfig,
        endTimeUnixMs,
      );

    res.code(200).send({ sessionId });
  }
}
