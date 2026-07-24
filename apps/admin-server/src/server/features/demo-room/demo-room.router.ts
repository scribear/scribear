import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { requireSessionHook } from '#src/server/shared/hooks/require-session.hook.js';

import { DEMO_ROOM_STATUS_ROUTE } from './demo-room.schema.js';

export function demoRoomRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...DEMO_ROOM_STATUS_ROUTE,
    preHandler: [requireSessionHook],
    handler: resolveHandler('demoRoomController', 'status'),
  });
}
