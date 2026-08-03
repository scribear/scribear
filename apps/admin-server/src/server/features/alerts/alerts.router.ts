import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { requireSessionHook } from '#src/server/shared/hooks/require-session.hook.js';

import { ALERTS_ROUTE } from './alerts.schema.js';

export function alertsRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...ALERTS_ROUTE,
    preHandler: [requireSessionHook],
    handler: resolveHandler('alertsController', 'alerts'),
  });
}
