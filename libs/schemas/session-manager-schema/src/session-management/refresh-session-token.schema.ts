import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';

import { SESSION_MANAGEMENT_TAG } from '../tags.js';

const REFRESH_SESSION_TOKEN_SCHEMA = {
  description:
    'Refreshes an expired or expiring session token using a refresh token.',
  tags: [SESSION_MANAGEMENT_TAG],
  body: Type.Object({
    sessionRefreshToken: Type.String(),
  }),
  response: {
    200: Type.Object(
      {
        sessionToken: Type.String({
          description: 'New signed JWT containing session id and scopes',
        }),
      },
      { description: 'Token refreshed successfully' },
    ),
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    401: SHARED_ERROR_REPLY_SCHEMA[401],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
} satisfies BaseRouteSchema;

const REFRESH_SESSION_TOKEN_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: '/api/session-manager/session-management/v1/refresh-session-token',
};

export { REFRESH_SESSION_TOKEN_SCHEMA, REFRESH_SESSION_TOKEN_ROUTE };
