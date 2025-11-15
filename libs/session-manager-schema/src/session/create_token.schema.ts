import { Type } from 'typebox';

import {
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';

const CREATE_TOKEN_SCHEMA = {
  description: 'Creates a JWT token for session access',
  tags: ['Session'],
  body: Type.Union([
    Type.Object({
      sessionId: Type.String({
        description: 'Session ID',
      }),
      audioSourceSecret: Type.String({
        description: 'Audio source secret for authentication',
      }),
      scope: Type.Union(
        [Type.Literal('source'), Type.Literal('sink'), Type.Literal('both')],
        {
          description: 'Access scope for the token',
        },
      ),
    }, {
      description: 'Token creation via session ID and audio source secret',
    }),
    Type.Object({
      joinCode: Type.String({
        description: 'Join code for accessing the session',
      }),
      scope: Type.Union(
        [Type.Literal('source'), Type.Literal('sink'), Type.Literal('both')],
        {
          description: 'Access scope for the token',
        },
      ),
    }, {
      description: 'Token creation via join code',
    }),
  ], {
    description: 'Token creation request',
  }),
  response: {
    200: Type.Object(
      {
        token: Type.String({ description: 'JWT access token' }),
        expiresIn: Type.String({
          description: 'Token expiration duration (e.g., "24h")',
        }),
        sessionId: Type.String({ description: 'Session identifier' }),
        scope: Type.String({ description: 'Token scope' }),
      },
      { description: 'Token created successfully' },
    ),
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    401: SHARED_ERROR_REPLY_SCHEMA[401],
    404: SHARED_ERROR_REPLY_SCHEMA[404],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
};

const CREATE_TOKEN_ROUTE: BaseRouteSchema = {
  method: 'POST',
  url: '/session/token',
};

export { CREATE_TOKEN_SCHEMA, CREATE_TOKEN_ROUTE };
