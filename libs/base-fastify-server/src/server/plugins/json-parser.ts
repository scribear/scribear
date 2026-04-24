import fastifyPlugin from 'fastify-plugin';

import { HttpError } from '../errors/http-errors.js';
import type { BaseFastifyInstance } from '../types/base-fastify-types.js';

/**
 * JSON body parser that produces a canonical `VALIDATION_ERROR` on malformed
 * input instead of fastify's default.
 */
export default fastifyPlugin((fastify: BaseFastifyInstance) => {
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      try {
        const parsedBody: unknown = JSON.parse(body.toString());
        done(null, parsedBody);
      } catch (parseError) {
        req.log.info({ msg: 'Failed to parse JSON body', err: parseError });

        done(
          HttpError.badRequest('Invalid JSON found in request body.', {
            validationErrors: [
              { message: 'Invalid JSON found in request body.', path: '/body' },
            ],
          }),
        );
      }
    },
  );
});
