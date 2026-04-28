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
import { DEVICE_MANAGEMENT_TAG } from '#src/tags.js';

const DELETE_DEVICE_SCHEMA = {
  description:
    "Delete a device. Fails with 409 if the device is its room's source, since the source invariant would be violated at commit; reassign the source first.",
  tags: [DEVICE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    deviceUid: Type.String({ format: 'uuid' }),
  }),
  response: {
    204: Type.Null({ description: 'Device deleted.' }),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('DEVICE_NOT_FOUND'),
      message: Type.String(),
    }),
    409: Type.Object({
      code: Type.Literal('WOULD_LEAVE_ROOM_WITHOUT_SOURCE'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const DELETE_DEVICE_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/device-management/delete-device`,
};

export { DELETE_DEVICE_SCHEMA, DELETE_DEVICE_ROUTE };
