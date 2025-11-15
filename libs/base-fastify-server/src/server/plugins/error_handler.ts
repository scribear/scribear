import fastifyPlugin from 'fastify-plugin';

import { SharedErrorReplySchema } from '@scribear/base-schema';

import { BaseHttpError, HttpError } from '../errors/http_errors.js';
import type {
  BaseFastifyInstance,
  BaseFastifyReply,
  BaseFastifyRequest,
} from '../types/base_fastify_types.js';

/**
 * Custom fastify error handler
 * Ensure BaseHttpErrors return correctly formatted responses
 * All other errors are caught and return InternalServerError response
 * Fastify errors are rethrown to be handled by fastify's default error handler
 */
export default fastifyPlugin((fastify: BaseFastifyInstance) => {
  fastify.setErrorHandler(
    (
      err: unknown,
      req: BaseFastifyRequest<{ response: typeof SharedErrorReplySchema }>,
      reply: BaseFastifyReply<{ response: typeof SharedErrorReplySchema }>,
    ) => {
      // Let default error handler manage FastifyErrors
      // FastifyErrors have a code property starting with 'FST_'
      if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string' && err.code.startsWith('FST_')) {
        throw new Error(`Fastify error: ${err.code}`);
      }

      if (!(err instanceof BaseHttpError)) {
        // If not BaseHttpError, return Internal Server Error
        req.log.info({
          msg: 'Request encountered internal server error',
          err,
        });

        return reply.code(500).send({
          message:
            'Sever encountered an unexpected error. Please try again later.',
        });
      }

      // If HttpBadRequest, include requestErrors in response
      if (err instanceof HttpError.BadRequest) {
        return reply
          .code(err.statusCode)
          .send({ requestErrors: err.requestErrors });
      }

      return reply.code(err.statusCode).send({ message: err.message });
    },
  );
});
