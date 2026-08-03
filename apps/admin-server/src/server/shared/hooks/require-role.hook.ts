import type { FastifyReply, FastifyRequest } from 'fastify';

import { errorEnvelope } from '../envelope/envelope.js';
import type { Role } from '../types/identity.js';
import { identityHasRole } from '../types/identity.js';

/**
 * Guards a route behind a required role. MUST run after `requireSessionHook`
 * (which populates `req.adminIdentity`). Mutations require `read-write`.
 *
 * @param role The role the caller must hold.
 */
export function requireRole(role: Role) {
  return async function requireRoleHook(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | undefined> {
    const identity = req.adminIdentity;
    if (!identity || !identityHasRole(identity, role)) {
      reply
        .code(403)
        .send(
          errorEnvelope(
            'FORBIDDEN',
            'You do not have permission to perform this action.',
            req.id,
          ),
        );
      return reply;
    }
  };
}
