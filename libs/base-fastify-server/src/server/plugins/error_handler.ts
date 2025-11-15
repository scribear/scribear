import fastifyPlugin from 'fastify-plugin';

import { SHARED_ERROR_REPLY_SCHEMA } from '@scribear/base-schema';

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
      req: BaseFastifyRequest<{ response: typeof SHARED_ERROR_REPLY_SCHEMA }>,
      reply: BaseFastifyReply<{ response: typeof SHARED_ERROR_REPLY_SCHEMA }>,
    ) => {
      // Let default error handler manage FastifyErrors
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        typeof err.code === 'string' &&
        err.code.startsWith('FST_')
      ) {
        throw err instanceof Error ? err : new Error(JSON.stringify(err));
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
