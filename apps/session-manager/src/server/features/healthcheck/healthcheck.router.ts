import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  HEALTHCHECK_ROUTE,
  HEALTHCHECK_SCHEMA,
} from '@scribear/session-manager-schema';

import resolveHandler from '../../dependency-injection/resolve-handler.js';

/**
 * Registers healthcheck routes
 * @param fastify Fastify app instance
 */
function healthcheckRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...HEALTHCHECK_ROUTE,
    schema: HEALTHCHECK_SCHEMA,
    handler: resolveHandler('healthcheckController', 'healthcheck'),
  });
}

export default healthcheckRouter;
