import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { requireSessionHook } from '#src/server/shared/hooks/require-session.hook.js';

import { CONFIG_CHECK_ROUTE } from './config-check.schema.js';

export function configCheckRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...CONFIG_CHECK_ROUTE,
    preHandler: [requireSessionHook],
    handler: resolveHandler('configCheckController', 'configCheck'),
  });
}
