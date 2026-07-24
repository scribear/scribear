import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  DEMO_ROOM_STATUS_ROUTE,
  DEMO_ROOM_STATUS_SCHEMA,
} from '@scribear/session-manager-schema';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { adminApiKeyHook } from '#src/server/hooks/admin-api-key.hook.js';

/**
 * Demo caption room status, for the admin console. Admin-key protected like the
 * other management routes; always registered (returns `enabled: false` when the
 * feature is off) so the console has a stable endpoint to poll.
 */
export function demoRoomRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...DEMO_ROOM_STATUS_ROUTE,
    schema: DEMO_ROOM_STATUS_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('demoRoomController', 'status'),
  });
}
