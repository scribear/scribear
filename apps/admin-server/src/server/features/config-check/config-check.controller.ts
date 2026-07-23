import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { okEnvelope } from '#src/server/shared/envelope/envelope.js';

export class ConfigCheckController {
  private _configCheckService: AppDependencies['configCheckService'];

  constructor(configCheckService: AppDependencies['configCheckService']) {
    this._configCheckService = configCheckService;
  }

  /**
   * Configuration posture of this deployment. Requires a session.
   *
   * Always 200, for the same reason the health rollup is: the check ran, and
   * what it found is the payload. A non-200 would be indistinguishable from
   * admin-server being broken, which is the one thing this route can always
   * speak for.
   *
   * The response contains no secret values — only classifications and lengths.
   * See `describeSecret`.
   */
  async configCheck(_req: BaseFastifyRequest, res: BaseFastifyReply) {
    const report = await this._configCheckService.check();
    res.code(200).send(okEnvelope(report));
  }
}
