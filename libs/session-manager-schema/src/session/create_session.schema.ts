import { Type } from 'typebox';

import {
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';

const CREATE_SESSION_SCHEMA = {
  description: 'Creates a new session with optional join code',
  tags: ['Session'],
  body: Type.Object(
    {
      sessionLength: Type.Integer({
        description: 'Session duration in seconds',
        minimum: 60,
        maximum: 86400, // 24 hours
      }),
      maxClients: Type.Optional(
        Type.Integer({
          description: 'Maximum number of clients allowed (0 = unlimited)',
          minimum: 0,
          default: 0,
        }),
      ),
      enableJoinCode: Type.Optional(
        Type.Boolean({
          description: 'Whether to generate a join code for external joining',
          default: false,
        }),
      ),
      audioSourceSecret: Type.String({
        description: 'Secret identifying the audio source (will be hashed)',
        minLength: 16,
      }),
    },
    {
      description: 'Session creation request',
    },
  ),
  response: {
    200: Type.Object(
      {
        sessionId: Type.String({ description: 'Unique session identifier' }),
        joinCode: Type.Optional(
          Type.String({
            description: 'Join code for external clients (if enabled)',
          }),
        ),
        expiresAt: Type.String({
          description: 'ISO 8601 timestamp when session expires',
        }),
      },
      { description: 'Session created successfully' },
    ),
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
};

const CREATE_SESSION_ROUTE: BaseRouteSchema = {
  method: 'POST',
  url: '/api/v1/session/create',
};

export { CREATE_SESSION_SCHEMA, CREATE_SESSION_ROUTE };
