import type { FastifyReply, FastifyRequest } from 'fastify';

import { errorEnvelope } from '../envelope/envelope.js';
import {
  SESSION_COOKIE_NAME,
  clearSessionCookieOptions,
} from '../http/cookie-options.js';

/**
 * Guards `/api/admin` routes: requires a valid, unexpired session cookie.
 * Attaches the resolved session + identity to the request. On failure, clears
 * the (stale) cookie and returns a 401 envelope — the SPA treats 401 as
 * "session expired, go to login".
 *
 * IMPORTANT: no upstream call is made when this fails.
 */
export async function requireSessionHook(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | undefined> {
  const sessionService = req.diScope.resolve('sessionService');

  const raw = req.cookies[SESSION_COOKIE_NAME];
  const unsigned = raw ? req.unsignCookie(raw) : null;
  const sessionId =
    unsigned && unsigned.valid && unsigned.value ? unsigned.value : undefined;

  const record = sessionService.validate(sessionId);
  if (!record) {
    reply.clearCookie(
      SESSION_COOKIE_NAME,
      clearSessionCookieOptions(sessionService.config.secure),
    );
    reply
      .code(401)
      .send(
        errorEnvelope('UNAUTHENTICATED', 'Authentication required.', req.id),
      );
    return reply;
  }

  req.adminSession = record;
  req.adminIdentity = record.identity;
  // `sessionId` is necessarily defined here (validate() returns null otherwise).
  if (sessionId) req.adminSessionId = sessionId;
}
