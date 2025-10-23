import fastifyPlugin from 'fastify-plugin';

import type { BaseFastifyInstance } from '../../types/base_fastify_types.js';

/**
 * Fastify onSend hook that adds X-Request-Id header to all responses
 */
export default fastifyPlugin((fastify: BaseFastifyInstance) => {
  fastify.addHook('onSend', (req, reply, _payload, done) => {
    reply.header('X-Request-ID', req.id);
    done();
  });
});
