import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  SCHEMA_STATUS_ROUTE,
  SCHEMA_STATUS_SCHEMA,
} from '@scribear/session-manager-schema';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { adminApiKeyHook } from '#src/server/hooks/admin-api-key.hook.js';

/**
 * Database schema state, for the admin console's Config Check. Admin-key
 * protected like the other management routes — this is operator information, and
 * `/api/session-manager/` is proxied to the internet.
 */
export function databaseRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...SCHEMA_STATUS_ROUTE,
    schema: SCHEMA_STATUS_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('databaseController', 'schemaStatus'),
  });
}
