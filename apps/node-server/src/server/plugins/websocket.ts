import fastifyWebsocket from '@fastify/websocket';
import fastifyPlugin from 'fastify-plugin';

import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

/**
 * Registers @fastify/websocket plugin for WebSocket support
 */
export default fastifyPlugin(async (fastify: BaseFastifyInstance) => {
    await fastify.register(fastifyWebsocket);

    fastify.log.info('WebSocket support enabled');
});
