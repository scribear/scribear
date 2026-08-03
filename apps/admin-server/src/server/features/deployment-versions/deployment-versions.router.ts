import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { requireSessionHook } from '#src/server/shared/hooks/require-session.hook.js';

import { DEPLOYMENT_VERSIONS_ROUTE } from './deployment-versions.schema.js';

export function deploymentVersionsRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...DEPLOYMENT_VERSIONS_ROUTE,
    preHandler: [requireSessionHook],
    handler: resolveHandler(
      'deploymentVersionsController',
      'deploymentVersions',
    ),
  });
}
