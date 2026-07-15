import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import {
  DEVICE_TOKEN_SECURITY,
  INVALID_DEVICE_TOKEN_REPLY_SCHEMA,
} from '#src/shared/security/device-token.js';
import { DEVICE_MANAGEMENT_TAG } from '#src/tags.js';

import { SELF_DEVICE_SCHEMA } from '../entities/device.schema.js';

const GET_MY_DEVICE_SCHEMA = {
  description:
    "Return the calling device's own details. Authenticated via the `DEVICE_TOKEN` cookie. Returns the self-scoped shape which omits admin-only fields.",
  tags: [DEVICE_MANAGEMENT_TAG],
  security: DEVICE_TOKEN_SECURITY,
  response: {
    200: SELF_DEVICE_SCHEMA,
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_DEVICE_TOKEN_REPLY_SCHEMA,
  },
} satisfies BaseRouteSchema;

const GET_MY_DEVICE_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/device-management/get-my-device`,
};

export { GET_MY_DEVICE_SCHEMA, GET_MY_DEVICE_ROUTE };
