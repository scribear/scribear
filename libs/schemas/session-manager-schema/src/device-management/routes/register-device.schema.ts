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
import { DEVICE_MANAGEMENT_TAG } from '#src/tags.js';

const REGISTER_DEVICE_SCHEMA = {
  description:
    'Register a new device. The response carries an activation code to hand to the device out-of-band; the device exchanges it via `activate-device` to receive its `DEVICE_TOKEN` cookie.',
  tags: [DEVICE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    name: Type.String({ minLength: 1, maxLength: 256 }),
  }),
  response: {
    201: Type.Object(
      {
        deviceUid: Type.String({ format: 'uuid' }),
        activationCode: Type.String(),
        expiry: Type.String({
          format: 'date-time',
          description: 'After this instant the activation code is invalid.',
        }),
      },
      { description: 'Device created in pending state.' },
    ),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
  },
} satisfies BaseRouteSchema;

const REGISTER_DEVICE_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/device-management/register-device`,
};

export { REGISTER_DEVICE_SCHEMA, REGISTER_DEVICE_ROUTE };
