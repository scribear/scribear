import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import { DEVICE_MANAGEMENT_TAG } from '#src/tags.js';

const ACTIVATE_DEVICE_SCHEMA = {
  description:
    'Exchange an activation code for a `DEVICE_TOKEN` cookie. The cookie is issued with a finite Max-Age and is refreshed by every subsequent authenticated request.',
  tags: [DEVICE_MANAGEMENT_TAG],
  body: Type.Object({
    activationCode: Type.String(),
  }),
  response: {
    200: Type.Object(
      {
        deviceUid: Type.String({ format: 'uuid' }),
      },
      {
        description:
          'Activation succeeded. The response includes a Set-Cookie header establishing DEVICE_TOKEN.',
      },
    ),
    ...STANDARD_ERROR_REPLIES,
    404: Type.Object({
      code: Type.Literal('ACTIVATION_CODE_NOT_FOUND'),
      message: Type.String(),
    }),
    410: Type.Object({
      code: Type.Literal('ACTIVATION_CODE_EXPIRED'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const ACTIVATE_DEVICE_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/device-management/activate-device`,
};

export { ACTIVATE_DEVICE_SCHEMA, ACTIVATE_DEVICE_ROUTE };
