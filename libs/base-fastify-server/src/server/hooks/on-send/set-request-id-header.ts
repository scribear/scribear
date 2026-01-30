import fastifyPlugin from 'fastify-plugin';

import type { BaseFastifyInstance } from '../../types/base-fastify-types.js';

/**
 * Fastify onSend hook that adds X-Request-Id header to all responses
 */
export default fastifyPlugin((fastify: BaseFastifyInstance) => {
  fastify.addHook('onSend', (req, reply, payload, done) => {
    reply.header('X-Request-ID', req.id);
    done(null, payload);
  });
});
