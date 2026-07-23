import type {
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import type { AppDependencies } from '#src/server/dependency-injection/app-dependencies.js';
import { okEnvelope } from '#src/server/shared/envelope/envelope.js';

export class HealthController {
  private _healthCheckerService: AppDependencies['healthCheckerService'];

  constructor(healthCheckerService: AppDependencies['healthCheckerService']) {
    this._healthCheckerService = healthCheckerService;
  }

  /**
   * Rollup of the pieces the admin console depends on. Requires a session — it
   * exposes infrastructure state. (Container/orchestration probes use the
   * unauthenticated `/probes/*` routes instead.)
   *
   * Always 200: the rollup itself succeeded even when what it found is bad
   * news. A non-200 here would be indistinguishable from the admin-server being
   * broken, which is the one component this route can always speak for.
   */
  async health(_req: BaseFastifyRequest, res: BaseFastifyReply) {
    const components = await this._healthCheckerService.check();

    res.code(200).send(
      okEnvelope({
        bff: 'ok' as const,
        components,
        checkedAt: new Date().toISOString(),
      }),
    );
  }
}
