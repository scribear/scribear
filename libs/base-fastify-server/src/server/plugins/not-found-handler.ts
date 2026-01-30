import type { FastifyRequest } from 'fastify';
import fastifyPlugin from 'fastify-plugin';

import { HttpError } from '../errors/http-errors.js';
import type { BaseFastifyInstance } from '../types/base-fastify-types.js';

/**
 * Custom fastify not found handler to throw custom 404 error
 */
export default fastifyPlugin((fastify: BaseFastifyInstance) => {
  fastify.setNotFoundHandler((req: FastifyRequest) => {
    throw new HttpError.NotFound(`Route ${req.method}: ${req.url} not found`);
  });
});
