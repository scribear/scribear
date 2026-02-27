import { asValue } from 'awilix';
import fastifyPlugin from 'fastify-plugin';

import type { BaseFastifyInstance } from '#src/server/types/base-fastify-types.js';

/**
 * Fastify onRequest hook that registers logger with request scoped dependency container
 * Allows logger to include reqId context
 */
export default fastifyPlugin((fastify: BaseFastifyInstance) => {
  fastify.addHook('onRequest', (req, reply, done) => {
    req.diScope.register({ logger: asValue(req.log) });
    done();
  });
});
