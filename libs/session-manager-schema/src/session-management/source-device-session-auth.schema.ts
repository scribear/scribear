import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';
import { TranscriptionProviderConfigSchema } from '@scribear/transcription-service-schema';

import { DEVICE_COOKIE_AUTH_SECURITY } from '#src/security.js';

import { SESSION_MANAGEMENT_TAG } from '../tags.js';

const SOURCE_DEVICE_SESSION_AUTH_SCHEMA = {
  description:
    'Authenticates a source device via cookie, returning a scoped JWT with send and receive permissions, along with the session key and config.',
  tags: [SESSION_MANAGEMENT_TAG],
  security: DEVICE_COOKIE_AUTH_SECURITY,
  body: Type.Object({
    sessionId: Type.String({ maxLength: 36 }),
  }),
  response: {
    200: Type.Object(
      {
        sessionToken: Type.String({
          description:
            'Signed JWT containing session id and scopes (SEND_AUDIO + RECEIVE_TRANSCRIPTIONS)',
        }),
        transcriptionProviderKey: Type.String(),
        transcriptionProviderConfig: TranscriptionProviderConfigSchema,
      },
      { description: 'Source device authenticated successfully' },
    ),
    401: SHARED_ERROR_REPLY_SCHEMA[401],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
} satisfies BaseRouteSchema;

const SOURCE_DEVICE_SESSION_AUTH_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: '/api/v1/session-management/source-device-session-auth',
};

export { SOURCE_DEVICE_SESSION_AUTH_SCHEMA, SOURCE_DEVICE_SESSION_AUTH_ROUTE };
