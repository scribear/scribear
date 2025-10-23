import { asValue } from 'awilix';
import fastifyPlugin from 'fastify-plugin';

import type { BaseLogger } from '../../create_logger.js';
import type { BaseFastifyInstance } from '../../types/base_fastify_types.js';

/**
 * Fastify onRequest hook that registers logger with request scoped dependency container
 * Allows logger to include reqId context
 */
export default fastifyPlugin((fastify: BaseFastifyInstance) => {
  fastify.addHook('onRequest', (req, reply, done) => {
    req.diScope.register({ logger: asValue(req.log as BaseLogger) });
    done();
  });
});
