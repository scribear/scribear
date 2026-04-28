import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import { READINESS_SCHEMA } from '@scribear/node-server-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

export class ReadinessController {
  private _sessionManagerClient: AppDependencies['sessionManagerClient'];

  constructor(sessionManagerClient: AppDependencies['sessionManagerClient']) {
    this._sessionManagerClient = sessionManagerClient;
  }

  async readiness(
    _req: BaseFastifyRequest<typeof READINESS_SCHEMA>,
    res: BaseFastifyReply<typeof READINESS_SCHEMA>,
  ) {
    const sessionManagerOk = await this._checkSessionManager();
    if (!sessionManagerOk) {
      // The transcription service is a WebSocket-only dependency; once the
      // orchestrator exposes a connection-state signal it will be probed
      // here too.
      res.code(503).send({
        status: 'fail',
        checks: {
          sessionManager: 'fail',
          transcriptionService: 'ok',
        },
      });
      return;
    }
    res.code(200).send({ status: 'ok' });
  }

  private async _checkSessionManager(): Promise<boolean> {
    const [, error] = await this._sessionManagerClient.probes.liveness({});
    return error === null;
  }
}
