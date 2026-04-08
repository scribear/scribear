import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';
import { TranscriptionProviderConfigSchema } from '@scribear/transcription-service-schema';

import {
  NODE_SERVER_KEY_AUTH_HEADER_SCHEMA,
  NODE_SERVER_KEY_AUTH_SECURITY,
} from '#src/security.js';

import { SESSION_MANAGEMENT_TAG } from '../tags.js';

const GET_SESSION_CONFIG_SCHEMA = {
  description:
    'Returns the transcription configuration for a session. Used by the node server to fetch config on session start.',
  tags: [SESSION_MANAGEMENT_TAG],
  security: NODE_SERVER_KEY_AUTH_SECURITY,
  headers: Type.Object({
    authorization: NODE_SERVER_KEY_AUTH_HEADER_SCHEMA,
  }),
  params: Type.Object({
    sessionId: Type.String({ maxLength: 36 }),
  }),
  response: {
    200: Type.Object(
      {
        transcriptionProviderKey: Type.String(),
        transcriptionProviderConfig: TranscriptionProviderConfigSchema,
        endTimeUnixMs: Type.Union([Type.Number(), Type.Null()]),
      },
      { description: 'Session config retrieved successfully' },
    ),
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    404: SHARED_ERROR_REPLY_SCHEMA[404],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
} satisfies BaseRouteSchema;

const GET_SESSION_CONFIG_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: '/api/session-manager/session-management/v1/session-config/:sessionId',
};

export { GET_SESSION_CONFIG_SCHEMA, GET_SESSION_CONFIG_ROUTE };
