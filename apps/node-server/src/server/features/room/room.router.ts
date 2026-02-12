import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '../../dependency-injection/resolve-handler.js';

/**
 * Registers room management REST routes
 * @param fastify Fastify app instance
 */
function roomRouter(fastify: BaseFastifyInstance) {
    fastify.route({
        method: 'GET',
        url: '/rooms',
        handler: resolveHandler('roomController', 'listRooms'),
    });

    fastify.route({
        method: 'GET',
        url: '/rooms/:sessionId',
        handler: resolveHandler('roomController', 'getRoom'),
    });
}

export default roomRouter;
