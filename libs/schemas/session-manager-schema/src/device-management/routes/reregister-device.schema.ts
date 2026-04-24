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

const REREGISTER_DEVICE_SCHEMA = {
  description:
    'Revoke an activated device and return a fresh activation code. The existing `DEVICE_TOKEN` is invalidated immediately by clearing the stored hash; outstanding session tokens remain valid until their natural expiry.',
  tags: [DEVICE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    deviceUid: Type.String({ format: 'uuid' }),
  }),
  response: {
    200: Type.Object(
      {
        activationCode: Type.String(),
        expiry: Type.String({ format: 'date-time' }),
      },
      { description: 'Device returned to pending state with a fresh code.' },
    ),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('DEVICE_NOT_FOUND'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const REREGISTER_DEVICE_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/device-management/reregister-device`,
};

export { REREGISTER_DEVICE_SCHEMA, REREGISTER_DEVICE_ROUTE };
