import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';

import { DEVICE_COOKIE_AUTH_SECURITY } from '#src/security.js';

import { SESSION_MANAGEMENT_TAG } from '../tags.js';

const GET_DEVICE_SESSIONS_SCHEMA = {
  description: 'Fetches current and upcoming sessions for the authenticated device.',
  tags: [SESSION_MANAGEMENT_TAG],
  security: DEVICE_COOKIE_AUTH_SECURITY,
  response: {
    200: Type.Object(
      {
        sessions: Type.Array(
          Type.Object({
            sessionId: Type.String(),
            startTime: Type.Number(),
            endTime: Type.Union([Type.Number(), Type.Null()]),
            isActive: Type.Boolean(),
          }),
        ),
      },
      { description: 'Device sessions fetched successfully' },
    ),
    401: SHARED_ERROR_REPLY_SCHEMA[401],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
} satisfies BaseRouteSchema;

const GET_DEVICE_SESSIONS_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: '/api/session-manager/session-management/v1/device-sessions',
};

export { GET_DEVICE_SESSIONS_SCHEMA, GET_DEVICE_SESSIONS_ROUTE };
