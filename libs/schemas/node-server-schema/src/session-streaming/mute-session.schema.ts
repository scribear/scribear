import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';

import { SESSION_STREAMING_TAG } from '../tags.js';

const MUTE_SESSION_SCHEMA = {
  description: 'Mute or unmute audio forwarding for a session',
  tags: [SESSION_STREAMING_TAG],
  params: Type.Object({ sessionId: Type.String({ maxLength: 36 }) }),
  headers: Type.Object({ authorization: Type.String() }),
  body: Type.Object({ muted: Type.Boolean() }),
  response: {
    200: Type.Object({}),
    401: SHARED_ERROR_REPLY_SCHEMA[401],
    404: SHARED_ERROR_REPLY_SCHEMA[404],
  },
} satisfies BaseRouteSchema;

const MUTE_SESSION_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: '/api/node-server/session-streaming/v1/mute-session/:sessionId',
};

export { MUTE_SESSION_SCHEMA, MUTE_SESSION_ROUTE };
