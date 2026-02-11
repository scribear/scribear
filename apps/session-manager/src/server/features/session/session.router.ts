import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  CREATE_SESSION_ROUTE,
  CREATE_SESSION_SCHEMA,
  CREATE_TOKEN_ROUTE,
  CREATE_TOKEN_SCHEMA,
} from '@scribear/session-manager-schema';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';

/**
 * Registers session management routes
 * @param fastify Fastify app instance
 */
function sessionRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...CREATE_SESSION_ROUTE,
    schema: CREATE_SESSION_SCHEMA,
    handler: resolveHandler('sessionController', 'createSession'),
  });

  fastify.route({
    ...CREATE_TOKEN_ROUTE,
    schema: CREATE_TOKEN_SCHEMA,
    handler: resolveHandler('sessionController', 'createToken'),
  });
}

export default sessionRouter;
