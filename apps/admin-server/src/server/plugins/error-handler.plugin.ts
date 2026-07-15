import fastifyPlugin from 'fastify-plugin';

import { BaseHttpError } from '@scribear/base-fastify-server';
import type {
  BaseFastifyInstance,
  BaseFastifyReply,
  BaseFastifyRequest,
} from '@scribear/base-fastify-server';

import { errorEnvelope } from '../shared/envelope/envelope.js';

/**
 * Admin BFF error handler. Overrides the base handler so that EVERY error
 * (validation, not-found, rate-limit, thrown application errors) is serialized
 * as the consistent `{ ok: false, error: { code, message, requestId } }`
 * envelope the SPA expects — never a bare `{ code, message }`.
 *
 * Registered after the base server so this `setErrorHandler` wins.
 */
export default fastifyPlugin((fastify: BaseFastifyInstance) => {
  fastify.setErrorHandler(
    (err: unknown, req: BaseFastifyRequest, reply: BaseFastifyReply) => {
      const requestId = req.id;

      // BaseHttpError covers validation (400), not-found (404), rate-limit
      // (429), and anything thrown via HttpError.* in the app.
      if (err instanceof BaseHttpError) {
        return reply
          .code(err.statusCode)
          .send(errorEnvelope(err.code, err.message, requestId, err.details));
      }

      // Other framework errors carrying a 4xx status: pass the status through.
      const status = (err as { statusCode?: unknown }).statusCode;
      if (typeof status === 'number' && status >= 400 && status < 500) {
        const rawCode = (err as { code?: unknown }).code;
        const rawMessage = (err as { message?: unknown }).message;
        return reply
          .code(status)
          .send(
            errorEnvelope(
              typeof rawCode === 'string' ? rawCode : 'REQUEST_ERROR',
              typeof rawMessage === 'string' ? rawMessage : 'Request failed.',
              requestId,
            ),
          );
      }

      // Everything else: log and return a generic 500 (no internals leaked).
      req.log.error({ err }, 'Unhandled error in admin BFF');
      return reply
        .code(500)
        .send(
          errorEnvelope(
            'INTERNAL_ERROR',
            'Server encountered an unexpected error.',
            requestId,
          ),
        );
    },
  );
});
