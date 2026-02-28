import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  CREATE_SESSION_ROUTE,
  CREATE_SESSION_SCHEMA,
} from '@scribear/session-manager-schema';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { apiKeyAuthHook } from '#src/server/hooks/api-key-auth.hook.js';

/**
 * Registers session management routes
 * @param fastify Fastify app instance
 */
export function sessionManagementRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...CREATE_SESSION_ROUTE,
    schema: CREATE_SESSION_SCHEMA,
    preHandler: apiKeyAuthHook,
    handler: resolveHandler('sessionManagementController', 'createSession'),
  });
}
