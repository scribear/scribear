import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '../../dependency-injection/resolve-handler.js';

/**
 * Registers healthcheck routes
 * @param fastify Fastify app instance
 */
function healthcheckRouter(fastify: BaseFastifyInstance) {
    fastify.route({
        method: 'GET',
        url: '/health',
        handler: resolveHandler('healthcheckController', 'healthcheck'),
    });
}

export default healthcheckRouter;
