import type { FastifyReply, FastifyRequest } from 'fastify';

import { errorEnvelope } from '../envelope/envelope.js';
import { CSRF_HEADER_NAME } from '../services/session.service.js';

/**
 * CSRF protection for state-changing routes (synchronizer-token pattern). The
 * SPA reads the session-bound CSRF token from the login / `/auth/me` response
 * body and echoes it in the `x-csrf-token` header. We compare it (constant
 * time) to the token stored on the session server-side.
 *
 * This is defense-in-depth on top of `SameSite=Strict`. MUST run after
 * `requireSessionHook`.
 */
export async function csrfHook(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | undefined> {
  const sessionService = req.diScope.resolve('sessionService');
  const session = req.adminSession;

  const headerValue = req.headers[CSRF_HEADER_NAME];
  const presented = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  if (!session || !sessionService.verifyCsrf(session, presented)) {
    reply
      .code(403)
      .send(
        errorEnvelope(
          'CSRF_TOKEN_INVALID',
          'Missing or invalid CSRF token.',
          req.id,
        ),
      );
    return reply;
  }
}
