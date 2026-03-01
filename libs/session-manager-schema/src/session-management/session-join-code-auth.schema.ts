import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';

import { SESSION_MANAGEMENT_TAG } from '../tags.js';

enum SessionScope {
  RECEIVE_TRANSCRIPTIONS = 'RECEIVE_TRANSCRIPTIONS',
  SEND_AUDIO = 'SEND_AUDIO',
}

const SESSION_JWT_PAYLOAD_SCHEMA = Type.Object({
  sessionId: Type.String(),
  scopes: Type.Array(Type.Enum(SessionScope)),
});

type SessionJwtPayload = Type.Static<typeof SESSION_JWT_PAYLOAD_SCHEMA>;

const SESSION_JOIN_CODE_AUTH_SCHEMA = {
  description:
    'Authenticates a session participant via join code, returning a scoped JWT.',
  tags: [SESSION_MANAGEMENT_TAG],
  body: Type.Object({
    joinCode: Type.String({ maxLength: 8 }),
  }),
  response: {
    200: Type.Object(
      {
        sessionToken: Type.String({
          description: 'Signed JWT containing session id and scopes',
        }),
      },
      { description: 'Session authenticated successfully' },
    ),
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
} satisfies BaseRouteSchema;

const SESSION_JOIN_CODE_AUTH_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: '/api/v1/session-management/session-join-code-auth',
};

export {
  SessionScope,
  SESSION_JWT_PAYLOAD_SCHEMA,
  SESSION_JOIN_CODE_AUTH_SCHEMA,
  SESSION_JOIN_CODE_AUTH_ROUTE,
};
export type { SessionScope as SessionScopeType, SessionJwtPayload };
