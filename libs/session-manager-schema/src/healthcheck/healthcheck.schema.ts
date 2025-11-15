import { Type } from 'typebox';

import {
  type BaseRouteSchema,
  SharedErrorReplySchema,
} from '@scribear/base-schema';

const HealthcheckSchema = {
  description: 'Probes liveliness of server',
  tags: ['Healthcheck'],
  response: {
    200: Type.Object({}, { description: 'Healthcheck successful' }),
    400: SHARED_ERROR_REPLY_SCHEMA[400],
    500: SHARED_ERROR_REPLY_SCHEMA[500],
  },
};

const HealthcheckRoute: BaseRouteSchema = {
  method: 'GET',
  url: '/healthcheck',
};

export { HealthcheckSchema, HealthcheckRoute };
