import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  SHARED_ERROR_REPLY_SCHEMA,
} from '@scribear/base-schema';

import { HEALTHCHECK_TAG } from '../tags.js';

const HEALTHCHECK_SCHEMA = {
  description: 'Probes liveliness of server',
  tags: [HEALTHCHECK_TAG],
  response: {
    200: Type.Object({}, { description: 'Healthcheck successful' }),
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
} satisfies BaseRouteSchema;

const HEALTHCHECK_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: '/healthcheck',
};

export { HEALTHCHECK_SCHEMA, HEALTHCHECK_ROUTE };
