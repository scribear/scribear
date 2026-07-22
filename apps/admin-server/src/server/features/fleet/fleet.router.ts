import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { requireSessionHook } from '#src/server/shared/hooks/require-session.hook.js';

import { FLEET_ROUTE } from './fleet.schema.js';

export function fleetRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...FLEET_ROUTE,
    preHandler: [requireSessionHook],
    handler: resolveHandler('fleetController', 'fleet'),
  });
}
