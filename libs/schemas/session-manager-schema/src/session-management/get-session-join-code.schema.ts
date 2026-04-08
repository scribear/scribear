import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';

import { DEVICE_COOKIE_AUTH_SECURITY } from '#src/security.js';

import { SESSION_MANAGEMENT_TAG } from '../tags.js';

const GET_SESSION_JOIN_CODE_SCHEMA = {
  description:
    'Returns the current join code for a session, rotating if close to expiry. Only the source device may request this.',
  tags: [SESSION_MANAGEMENT_TAG],
  security: DEVICE_COOKIE_AUTH_SECURITY,
  params: Type.Object({
    sessionId: Type.String({ maxLength: 36 }),
  }),
  response: {
    200: Type.Object(
      {
        joinCode: Type.String(),
        expiresAtUnixMs: Type.Number(),
      },
      { description: 'Current join code for the session' },
    ),
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    401: SHARED_ERROR_REPLY_SCHEMA[401],
    404: SHARED_ERROR_REPLY_SCHEMA[404],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
} satisfies BaseRouteSchema;

const GET_SESSION_JOIN_CODE_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: '/api/session-manager/session-management/v1/session-join-code/:sessionId',
};

export { GET_SESSION_JOIN_CODE_SCHEMA, GET_SESSION_JOIN_CODE_ROUTE };
