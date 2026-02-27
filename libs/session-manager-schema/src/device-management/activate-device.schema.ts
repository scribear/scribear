import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';

import { DEVICE_MANAGEMENT_TAG } from '../tags.js';

const ACTIVATE_DEVICE_SCHEMA = {
  description:
    'Activates device after registration. Sets cookie containing device token on client.',
  tags: [DEVICE_MANAGEMENT_TAG],
  body: Type.Object({
    activationCode: Type.String({ minLength: 8, maxLength: 8 }),
  }),
  response: {
    200: Type.Object(
      {
        deviceId: Type.String(),
        deviceName: Type.String(),
      },
      {
        description: 'Successful activation',
        headers: {
          'Set-Cookie': Type.String({ description: 'Device token' }),
        },
      },
    ),
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
} satisfies BaseRouteSchema;

const ACTIVATE_DEVICE_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: '/api/v1/device-management/activate-device',
};

export { ACTIVATE_DEVICE_SCHEMA, ACTIVATE_DEVICE_ROUTE };
