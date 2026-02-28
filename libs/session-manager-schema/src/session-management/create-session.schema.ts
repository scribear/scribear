import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';
import { TranscriptionProviderConfigSchema } from '@scribear/transcription-service-schema';

import {
  API_KEY_AUTH_HEADER_SCHEMA,
  API_KEY_AUTH_SECURITY,
} from '#src/security.js';

import { SESSION_MANAGEMENT_TAG } from '../tags.js';

const CREATE_SESSION_SCHEMA = {
  description: 'Creates an on demand session that starts immediately.',
  tags: [SESSION_MANAGEMENT_TAG],
  security: API_KEY_AUTH_SECURITY,
  headers: Type.Object({
    authorization: API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    sourceDeviceId: Type.String({ maxLength: 36 }),
    transcriptionProviderKey: Type.String({ maxLength: 32 }),
    transcriptionProviderConfig: TranscriptionProviderConfigSchema,
    endTimeUnixMs: Type.Number(),
  }),
  response: {
    200: Type.Object(
      {
        sessionId: Type.String(),
      },
      {
        description: 'Session created successfully',
      },
    ),
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
} satisfies BaseRouteSchema;

const CREATE_SESSION_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: '/api/v1/session-management/create-session',
};

export { CREATE_SESSION_SCHEMA, CREATE_SESSION_ROUTE };
