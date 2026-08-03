// Importing this module for its side effect augments FastifyRequest with the
// admin session/identity attached by `requireSessionHook`.
import type { SessionRecord } from '../services/session.service.js';
import type { Identity } from './identity.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The validated admin session, set by `requireSessionHook`. */
    adminSession?: SessionRecord;
    /** Convenience alias for `adminSession.identity`. */
    adminIdentity?: Identity;
    /** The opaque session id (needed by logout to revoke). */
    adminSessionId?: string;
  }
}
