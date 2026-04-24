import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import {
  ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  ADMIN_API_KEY_SECURITY,
  INVALID_ADMIN_KEY_REPLY_SCHEMA,
} from '#src/shared/security/admin-api-key.js';
import { ROOM_MANAGEMENT_TAG } from '#src/tags.js';

import { ROOM_SCHEMA } from '../entities/room.schema.js';

const CREATE_ROOM_SCHEMA = {
  description:
    'Create a new room. The `timezone` must be a valid IANA identifier; auto-session fields are optional and default to disabled.',
  tags: [ROOM_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    name: Type.String({ minLength: 1, maxLength: 256 }),
    timezone: Type.String({
      description: 'IANA timezone identifier.',
      examples: ['America/New_York'],
    }),
    autoSessionEnabled: Type.Optional(Type.Boolean({ default: false })),
    autoSessionTranscriptionProviderId: Type.Optional(
      Type.Union([Type.String(), Type.Null()]),
    ),
    autoSessionTranscriptionStreamConfig: Type.Optional(
      Type.Union([Type.Unknown(), Type.Null()]),
    ),
    sourceDeviceUids: Type.Array(Type.String({ format: 'uuid' }), {
      minItems: 1,
      description:
        'Source devices to be associated with room. Currently only exactly one allowed.',
    }),
  }),
  response: {
    201: ROOM_SCHEMA,
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('DEVICE_NOT_FOUND'),
      message: Type.String(),
    }),
    409: Type.Union([
      Type.Object({
        code: Type.Literal('DEVICE_ALREADY_IN_ROOM'),
        message: Type.String(),
      }),
      Type.Object({
        code: Type.Literal('TOO_MANY_SOURCE_DEVICES'),
        message: Type.String(),
      }),
    ]),
    422: Type.Object({
      code: Type.Literal('INVALID_TIMEZONE'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const CREATE_ROOM_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/room-management/create-room`,
};

export { CREATE_ROOM_SCHEMA, CREATE_ROOM_ROUTE };
