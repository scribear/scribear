import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';

import {
  API_KEY_AUTH_HEADER_SCHEMA,
  API_KEY_AUTH_SECURITY,
} from '../security.js';
import { DEVICE_MANAGEMENT_TAG } from '../tags.js';

const REGISTER_DEVICE_SCHEMA = {
  description:
    'Register a new device to server. Returns an activation code that device needs to use to activate registration.',
  tags: [DEVICE_MANAGEMENT_TAG],
  security: API_KEY_AUTH_SECURITY,
  headers: Type.Object({
    authorization: API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    deviceName: Type.String({ maxLength: 256 }),
  }),
  response: {
    200: Type.Object(
      {
        deviceId: Type.String(),
        activationCode: Type.String(),
      },
      { description: 'Registration successful.' },
    ),
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    401: SHARED_ERROR_REPLY_SCHEMA[401],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
} satisfies BaseRouteSchema;

const REGISTER_DEVICE_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: '/api/v1/device-management/register-device',
};

export { REGISTER_DEVICE_SCHEMA, REGISTER_DEVICE_ROUTE };
