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

const REMOVE_DEVICE_FROM_ROOM_SCHEMA = {
  description:
    'Detach a device from its room. Fails with 409 if doing so would leave the room without a source device.',
  tags: [ROOM_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    deviceUid: Type.String({ format: 'uuid' }),
  }),
  response: {
    204: Type.Null({ description: 'Device detached.' }),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('MEMBERSHIP_NOT_FOUND'),
      message: Type.String(),
    }),
    409: Type.Object({
      code: Type.Literal('WOULD_LEAVE_ROOM_WITHOUT_SOURCE'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const REMOVE_DEVICE_FROM_ROOM_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/room-management/remove-device-from-room`,
};

export { REMOVE_DEVICE_FROM_ROOM_SCHEMA, REMOVE_DEVICE_FROM_ROOM_ROUTE };
