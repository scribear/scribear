import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import { SESSION_SCOPE_SCHEMA } from '#src/shared/entities/session-scope.schema.js';
import { SESSION_AUTH_TAG } from '#src/tags.js';

const EXCHANGE_JOIN_CODE_SCHEMA = {
  description:
    "Exchange a join code for a session token and session refresh token. No prior authentication required - the join code is the credential. Scopes are the session's joinCodeScopes.",
  tags: [SESSION_AUTH_TAG],
  body: Type.Object({
    joinCode: Type.String({
      description: '8-character alphanumeric join code.',
    }),
  }),
  response: {
    200: Type.Object({
      sessionUid: Type.String({ format: 'uuid' }),
      clientId: Type.String({
        format: 'uuid',
        description:
          'Server-generated identifier for this client connection. Stored alongside the refresh token.',
      }),
      sessionToken: Type.String({
        description: 'Short-lived JWT (~5 minutes).',
      }),
      sessionTokenExpiresAt: Type.String({ format: 'date-time' }),
      sessionRefreshToken: Type.String({
        description: 'Long-lived opaque token valid for the session lifetime.',
      }),
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
  },
} satisfies BaseRouteSchema;

const EXCHANGE_JOIN_CODE_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/session-auth/exchange-join-code`,
};

export { EXCHANGE_JOIN_CODE_SCHEMA, EXCHANGE_JOIN_CODE_ROUTE };
