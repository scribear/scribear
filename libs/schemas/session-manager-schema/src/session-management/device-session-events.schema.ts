import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';

import { DEVICE_COOKIE_AUTH_SECURITY } from '#src/security.js';

import { SESSION_MANAGEMENT_TAG } from '../tags.js';

enum DeviceSessionEventType {
  START_SESSION = 'START_SESSION',
  END_SESSION = 'END_SESSION',
}

const DEVICE_SESSION_EVENTS_SCHEMA = {
  description: 'Creates an on demand session that starts immediately.',
  tags: [SESSION_MANAGEMENT_TAG],
  security: DEVICE_COOKIE_AUTH_SECURITY,
  querystring: Type.Object({
    prevEventId: Type.Optional(Type.Number()),
  }),
  response: {
    200: Type.Union([
      Type.Null({ description: 'No session events currently' }),
      Type.Object(
        {
          eventId: Type.Number(),
          eventType: Type.Enum(DeviceSessionEventType),
          sessionId: Type.String(),
          timestampUnixMs: Type.Number(),
        },
        {
          description: 'Session event fetched successfully',
        },
      ),
    ]),
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    401: SHARED_ERROR_REPLY_SCHEMA[401],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
} satisfies BaseRouteSchema;

const DEVICE_SESSION_EVENTS_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: '/api/session-manager/session-management/v1/device-session-events',
};

export {
  DeviceSessionEventType,
  DEVICE_SESSION_EVENTS_SCHEMA,
  DEVICE_SESSION_EVENTS_ROUTE,
};
