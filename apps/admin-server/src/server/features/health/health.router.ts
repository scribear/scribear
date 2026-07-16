import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { requireSessionHook } from '#src/server/shared/hooks/require-session.hook.js';

import { HEALTH_ROUTE } from './health.schema.js';

export function healthRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...HEALTH_ROUTE,
    preHandler: [requireSessionHook],
    handler: resolveHandler('healthController', 'health'),
  });
}
