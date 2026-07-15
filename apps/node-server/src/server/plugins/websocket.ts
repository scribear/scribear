import fastifyWebsocket from '@fastify/websocket';
import fastifyPlugin from 'fastify-plugin';

import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

/**
 * Registers the @fastify/websocket plugin so feature routers can declare WS
 * routes (`websocket: true` on the route definition). The plugin is registered
 * once at server bootstrap; per-route handler wiring lives in feature routers.
 */
export default fastifyPlugin(async (fastify: BaseFastifyInstance) => {
  await fastify.register(fastifyWebsocket);
});
