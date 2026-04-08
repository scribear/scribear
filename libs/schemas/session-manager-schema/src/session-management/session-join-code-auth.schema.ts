import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';

import { SESSION_MANAGEMENT_TAG } from '../tags.js';

const SESSION_JOIN_CODE_AUTH_SCHEMA = {
  description:
    'Authenticates a session participant via join code, returning a scoped JWT.',
  tags: [SESSION_MANAGEMENT_TAG],
  body: Type.Object({
    joinCode: Type.String({ maxLength: 16 }),
  }),
  response: {
    200: Type.Object(
      {
        sessionToken: Type.String({
          description: 'Signed JWT containing session id and scopes',
        }),
        sessionRefreshToken: Type.String({
          description: 'Opaque refresh token for obtaining new session tokens',
        }),
      },
      { description: 'Session authenticated successfully' },
    ),
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    422: SHARED_ERROR_REPLY_SCHEMA[422],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
} satisfies BaseRouteSchema;

const SESSION_JOIN_CODE_AUTH_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: '/api/session-manager/session-management/v1/session-join-code-auth',
};

export { SESSION_JOIN_CODE_AUTH_SCHEMA, SESSION_JOIN_CODE_AUTH_ROUTE };
