import { Type } from 'typebox';

import {
  type BaseRouteSchema,
  SharedErrorReplySchema,
} from '@scribear/base-schema';

const HealthcheckSchema = {
  description: 'Probes liveliness of server',
  tags: ['Healthcheck'],
  response: {
    200: Type.Object(
      { reqId: Type.String() },
      { description: 'Healthcheck successful' },
    ),
    400: SharedErrorReplySchema[400],
    500: SharedErrorReplySchema[500],
  },
};

const HealthcheckRoute: BaseRouteSchema = {
  method: 'GET',
  url: '/healthcheck',
};

export { HealthcheckSchema, HealthcheckRoute };
