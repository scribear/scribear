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

import { DEVICE_SCHEMA } from '../entities/device.schema.js';

const GET_DEVICE_SCHEMA = {
  description: 'Fetch a single device by uid.',
  tags: [DEVICE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  params: Type.Object({
    deviceUid: Type.String({ format: 'uuid' }),
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

const GET_DEVICE_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/device-management/get-device/:deviceUid`,
};

export { GET_DEVICE_SCHEMA, GET_DEVICE_ROUTE };
