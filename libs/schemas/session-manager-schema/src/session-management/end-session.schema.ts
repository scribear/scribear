import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';

import {
  API_KEY_AUTH_HEADER_SCHEMA,
  API_KEY_AUTH_SECURITY,
} from '#src/security.js';

import { SESSION_MANAGEMENT_TAG } from '../tags.js';

const END_SESSION_SCHEMA = {
  description: 'Ends an active session immediately.',
  tags: [SESSION_MANAGEMENT_TAG],
  security: API_KEY_AUTH_SECURITY,
  headers: Type.Object({
    authorization: API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    sessionId: Type.String({ maxLength: 36 }),
  }),
  response: {
    200: Type.Object({}, { description: 'Session ended successfully' }),
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    404: SHARED_ERROR_REPLY_SCHEMA[404],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
} satisfies BaseRouteSchema;

const END_SESSION_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: '/api/session-manager/session-management/v1/end-session',
};

export { END_SESSION_SCHEMA, END_SESSION_ROUTE };
