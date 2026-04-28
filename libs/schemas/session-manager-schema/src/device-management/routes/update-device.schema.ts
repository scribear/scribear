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

import { DEVICE_SCHEMA } from '../entities/device.schema.js';

const UPDATE_DEVICE_SCHEMA = {
  description:
    'Update mutable fields on a device. Activation state and room membership have dedicated endpoints and cannot be changed here.',
  tags: [DEVICE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    deviceUid: Type.String({ format: 'uuid' }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  }),
  response: {
    200: DEVICE_SCHEMA,
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('DEVICE_NOT_FOUND'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const UPDATE_DEVICE_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/device-management/update-device`,
};

export { UPDATE_DEVICE_SCHEMA, UPDATE_DEVICE_ROUTE };
