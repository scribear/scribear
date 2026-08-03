import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { okEnvelope } from '#src/server/shared/envelope/envelope.js';

export class DeploymentVersionsController {
  private _deploymentVersionsService: AppDependencies['deploymentVersionsService'];

  constructor(
    deploymentVersionsService: AppDependencies['deploymentVersionsService'],
  ) {
    this._deploymentVersionsService = deploymentVersionsService;
  }

  /**
   * What each container in this deployment was built from. Requires a session.
   *
   * Always 200, like the health rollup and the config check: the probe ran, and
   * what it found is the payload. A container that did not answer is a row with
   * a status, not a failed request — a non-200 here would hide the nine
   * containers that did answer behind the one that did not.
   *
   * Session-gated because it discloses commit hashes and build times for the
   * whole stack. Individually each container's `/build-info` is unauthenticated,
   * but it is also unreachable from outside the compose network; this route is
   * the one place all of them are readable from a browser.
   */
  async deploymentVersions(_req: BaseFastifyRequest, res: BaseFastifyReply) {
    const report = await this._deploymentVersionsService.report();
    res.code(200).send(okEnvelope(report));
  }
}
