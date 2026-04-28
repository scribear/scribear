import { Type } from 'typebox';

import type {
  BaseRouteDefinition,
  BaseRouteSchema,
} from '@scribear/base-schema';

import { NODE_SERVER_BASE_PATH } from '#src/base-path.js';
import { PROBES_TAG } from '#src/tags.js';

const LIVENESS_SCHEMA = {
  description:
    'Liveness probe. Returns 200 once the process is accepting requests. Does not check dependencies.',
  tags: [PROBES_TAG],
  response: {
    200: Type.Object(
      { status: Type.Literal('ok') },
      { description: 'Process is alive.' },
    ),
  },
} satisfies BaseRouteSchema;

const LIVENESS_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${NODE_SERVER_BASE_PATH}/probes/liveness`,
};

export { LIVENESS_SCHEMA, LIVENESS_ROUTE };
