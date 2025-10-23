import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  COMPUTE_BINOMIAL_ROUTE,
  COMPUTE_BINOMIAL_SCHEMA,
  COMPUTE_MONOMIAL_ROUTE,
  COMPUTE_MONOMIAL_SCHEMA,
} from '@scribear/session-manager-schema';

import resolveHandler from '../../dependency_injection/resolve_handler.js';

/**
 * Registers calculator demo routes
 * @param fastify Fastify app instance
 */
function calculatorRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...COMPUTE_BINOMIAL_ROUTE,
    schema: COMPUTE_BINOMIAL_SCHEMA,
    handler: resolveHandler('calculatorController', 'binomial'),
  });

  fastify.route({
    ...COMPUTE_MONOMIAL_ROUTE,
    schema: COMPUTE_MONOMIAL_SCHEMA,
    handler: resolveHandler('calculatorController', 'monomial'),
  });
}

export default calculatorRouter;
