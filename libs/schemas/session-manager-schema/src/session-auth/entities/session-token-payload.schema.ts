import { type Static, Type } from 'typebox';

import { SESSION_SCOPE_SCHEMA } from '#src/shared/entities/session-scope.schema.js';

/**
 * Decoded contents of a verified session token. Session Manager signs tokens
 * with this shape and downstream services (Node Server) verify them locally
 * using a shared HMAC signing key.
 *
 * `exp` is a Unix timestamp in seconds (matching the JWT convention) so the
 * wire form stays compact. `clientId` uniquely identifies the device or
 * browser tab that obtained the token, separating concurrent connections of
 * the same `sessionUid`.
 */
export const SESSION_TOKEN_PAYLOAD_SCHEMA = Type.Object(
  {
    sessionUid: Type.String({ format: 'uuid' }),
    clientId: Type.String(),
    scopes: Type.Array(SESSION_SCOPE_SCHEMA),
    exp: Type.Integer(),
  },
  { $id: 'SessionTokenPayload' },
);

export type SessionTokenPayload = Static<typeof SESSION_TOKEN_PAYLOAD_SCHEMA>;
