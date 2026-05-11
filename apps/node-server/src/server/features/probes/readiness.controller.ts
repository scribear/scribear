import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';
import { READINESS_SCHEMA } from '@scribear/node-server-schema';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';

export class ReadinessController {
  private _sessionManagerClient: AppDependencies['sessionManagerClient'];
  private _transcriptionServiceClient: AppDependencies['transcriptionServiceClient'];

  constructor(
    sessionManagerClient: AppDependencies['sessionManagerClient'],
    transcriptionServiceClient: AppDependencies['transcriptionServiceClient'],
  ) {
    this._sessionManagerClient = sessionManagerClient;
    this._transcriptionServiceClient = transcriptionServiceClient;
  }

  async readiness(
    _req: BaseFastifyRequest<typeof READINESS_SCHEMA>,
    res: BaseFastifyReply<typeof READINESS_SCHEMA>,
  ) {
    const [sessionManagerOk, transcriptionServiceOk] = await Promise.all([
      this._checkSessionManager(),
      this._checkTranscriptionService(),
    ]);
    if (!sessionManagerOk || !transcriptionServiceOk) {
      res.code(503).send({
        status: 'fail',
        checks: {
          sessionManager: sessionManagerOk ? 'ok' : 'fail',
          transcriptionService: transcriptionServiceOk ? 'ok' : 'fail',
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

  private async _checkTranscriptionService(): Promise<boolean> {
    const [, error] = await this._transcriptionServiceClient.probes.liveness(
      {},
    );
    return error === null;
  }
}
