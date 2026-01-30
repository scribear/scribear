import fastifyPlugin from 'fastify-plugin';

import { HttpError } from '../errors/http-errors.js';
import type { BaseFastifyInstance } from '../types/base-fastify-types.js';

/**
 * Custom fastify not found handler to throw custom 400 error
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
          new HttpError.BadRequest([
            { message: 'Invalid JSON found in request body.', key: '/body' },
          ]),
        );
      }
    },
  );
});
