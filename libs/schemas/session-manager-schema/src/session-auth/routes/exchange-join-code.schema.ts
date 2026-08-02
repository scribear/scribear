import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  RATE_LIMITED_REPLY_SCHEMA,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import { SESSION_SCOPE_SCHEMA } from '#src/shared/entities/session-scope.schema.js';
import { SESSION_AUTH_TAG } from '#src/tags.js';

const EXCHANGE_JOIN_CODE_SCHEMA = {
  description:
    "Exchange a join code for a session token and session refresh token. No prior authentication required - the join code itself is the credential. Scopes granted are the session's joinCodeScopes. Rate-limited per client IP, so a 429 is expected whenever a whole room joins from behind one NAT; it is transient and clears when the window rolls over.",
  tags: [SESSION_AUTH_TAG],
  body: Type.Object({
    joinCode: Type.String(),
  }),
  response: {
    200: Type.Object({
      sessionUid: Type.String({ format: 'uuid' }),
      clientId: Type.String({
        format: 'uuid',
        description:
          'Server-generated UUID identifying this client connection. Stored with the refresh token for future client management.',
      }),
      sessionToken: Type.String(),
      sessionTokenExpiresAt: Type.String({ format: 'date-time' }),
      sessionRefreshToken: Type.String(),
      scopes: Type.Array(SESSION_SCOPE_SCHEMA),
    }),
    ...STANDARD_ERROR_REPLIES,
    404: Type.Object({
      code: Type.Literal('JOIN_CODE_NOT_FOUND'),
      message: Type.String(),
    }),
    409: Type.Object({
      code: Type.Literal('SESSION_NOT_CURRENTLY_ACTIVE'),
      message: Type.String(),
    }),
    410: Type.Object({
      code: Type.Literal('JOIN_CODE_EXPIRED'),
      message: Type.String(),
    }),
    // Declared because this route opts into a per-IP rate limit (see the
    // session-auth router). Undeclared, it arrived at the client as an
    // `UnexpectedResponseError`, collapsed into "Unable to join session.
    // Please try again." and told a lecture hall on one NAT to do the exact
    // thing that produced the 429.
    429: RATE_LIMITED_REPLY_SCHEMA,
  },
} satisfies BaseRouteSchema;

const EXCHANGE_JOIN_CODE_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/session-auth/exchange-join-code`,
};

export { EXCHANGE_JOIN_CODE_SCHEMA, EXCHANGE_JOIN_CODE_ROUTE };
