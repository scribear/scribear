import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  HealthcheckRoute,
  HealthcheckSchema,
} from '@scribear/session-manager-schema';

import resolveHandler from '../../dependency_injection/resolve_handler.js';

/**
 * Registers healthcheck routes
 * @param fastify Fastify app instance
 */
function healthcheckRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...HealthcheckRoute,
    schema: HealthcheckSchema,
    handler: resolveHandler('healthcheckController', 'healthcheck'),
  });
}

export default healthcheckRouter;
