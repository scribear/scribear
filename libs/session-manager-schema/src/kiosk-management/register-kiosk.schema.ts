import Type from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';

import {
  API_KEY_AUTH_HEADER_SCHEMA,
  API_KEY_AUTH_SECURITY,
} from '../security.js';
import { KIOSK_MANAGEMENT_TAG } from '../tags.js';

export const REGISTER_KIOSK_SCHEMA = {
  description: 'Register a new kiosk with session manager.',
  tags: [KIOSK_MANAGEMENT_TAG],
  headers: Type.Object({
    authorization: API_KEY_AUTH_HEADER_SCHEMA,
  }),
  security: [API_KEY_AUTH_SECURITY],
  response: {
    200: Type.Object({
      id: Type.String({ description: 'Unique kiosk identifier' }),
      secret: Type.String({
        description: 'Secret token for authenticating kiosk',
      }),
    }),
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    401: SHARED_ERROR_REPLY_SCHEMA[401],
    403: SHARED_ERROR_REPLY_SCHEMA[403],
  },
} satisfies BaseRouteSchema;

export const REGISTER_KIOSK_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: '/api/v1/kiosk-management/register',
};
