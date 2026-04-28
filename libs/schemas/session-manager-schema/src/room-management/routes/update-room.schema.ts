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

const UPDATE_ROOM_SCHEMA = {
  description: 'Update mutable fields on a room.',
  tags: [ROOM_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    roomUid: Type.String({ format: 'uuid' }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  }),
  response: {
    200: ROOM_SCHEMA,
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('ROOM_NOT_FOUND'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const UPDATE_ROOM_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/room-management/update-room`,
};

export { UPDATE_ROOM_SCHEMA, UPDATE_ROOM_ROUTE };
