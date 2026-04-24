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
} from '#src/security/admin-api-key.js';
import { ROOM_MANAGEMENT_TAG } from '#src/tags.js';

const SET_SOURCE_DEVICE_SCHEMA = {
  description:
    'Mark `deviceUid` as the source for its room, clearing `is_source` on any other member device of the same room. Runs inside one transaction so the source swap satisfies the "exactly one source per room" invariant at commit.',
  tags: [ROOM_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    roomUid: Type.String({ format: 'uuid' }),
    deviceUid: Type.String({ format: 'uuid' }),
  }),
  response: {
    204: Type.Null({ description: 'Source device updated.' }),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Union([
      Type.Object({
        code: Type.Literal('ROOM_NOT_FOUND'),
        message: Type.String(),
      }),
      Type.Object({
        code: Type.Literal('DEVICE_NOT_IN_ROOM'),
        message: Type.String(),
      }),
    ]),
  },
} satisfies BaseRouteSchema;

const SET_SOURCE_DEVICE_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/room-management/set-source-device`,
};

export { SET_SOURCE_DEVICE_SCHEMA, SET_SOURCE_DEVICE_ROUTE };
