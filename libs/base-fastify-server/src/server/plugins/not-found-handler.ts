import type { FastifyRequest } from 'fastify';
import fastifyPlugin from 'fastify-plugin';

import { HttpError } from '../errors/http-errors.js';
import type { BaseFastifyInstance } from '../types/base-fastify-types.js';

/**
 * Custom 404 handler producing a canonical `ROUTE_NOT_FOUND` error instead of
 * fastify's default body.
 */
export default fastifyPlugin((fastify: BaseFastifyInstance) => {
  fastify.setNotFoundHandler((req: FastifyRequest) => {
    throw HttpError.notFound(
      'ROUTE_NOT_FOUND',
      `Route ${req.method}: ${req.url} not found.`,
    );
  });
});
