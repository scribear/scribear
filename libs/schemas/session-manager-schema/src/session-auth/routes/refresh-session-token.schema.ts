import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import { SESSION_AUTH_TAG } from '#src/tags.js';

const REFRESH_SESSION_TOKEN_SCHEMA = {
  description:
    'Exchange a session refresh token for a fresh short-lived session token. No prior authentication required - the refresh token itself is the credential.',
  tags: [SESSION_AUTH_TAG],
  body: Type.Object({
    sessionRefreshToken: Type.String(),
  }),
  response: {
    200: Type.Object({
      sessionToken: Type.String(),
      sessionTokenExpiresAt: Type.String({ format: 'date-time' }),
    }),
    ...STANDARD_ERROR_REPLIES,
    401: Type.Object({
      code: Type.Literal('INVALID_REFRESH_TOKEN'),
      message: Type.String(),
    }),
    409: Type.Object({
      code: Type.Literal('SESSION_ENDED'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const REFRESH_SESSION_TOKEN_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/session-auth/refresh-session-token`,
};

export { REFRESH_SESSION_TOKEN_SCHEMA, REFRESH_SESSION_TOKEN_ROUTE };
