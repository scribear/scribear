import { Type } from 'typebox';

import type {
  BaseRouteDefinition,
  BaseRouteSchema,
} from '@scribear/base-schema';

const LIVENESS_SCHEMA = {
  description:
    'Liveness probe. Returns 200 once the process is accepting requests. Does not check dependencies.',
  tags: [],
  response: {
    200: Type.Object(
      { status: Type.Literal('ok') },
      { description: 'Process is alive.' },
    ),
  },
} satisfies BaseRouteSchema;

const LIVENESS_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: '/probes/liveness',
};

export { LIVENESS_SCHEMA, LIVENESS_ROUTE };
