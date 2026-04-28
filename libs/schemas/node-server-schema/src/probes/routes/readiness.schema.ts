import { Type } from 'typebox';

import type {
  BaseRouteDefinition,
  BaseRouteSchema,
} from '@scribear/base-schema';

import { NODE_SERVER_BASE_PATH } from '#src/base-path.js';
import { PROBES_TAG } from '#src/tags.js';

const READINESS_SCHEMA = {
  description:
    'Readiness probe. Returns 200 when all dependencies are reachable. Returns 503 when any dependency is down.',
  tags: [PROBES_TAG],
  response: {
    200: Type.Object(
      { status: Type.Literal('ok') },
      { description: 'All dependencies reachable.' },
    ),
    503: Type.Object(
      {
        status: Type.Literal('fail'),
        checks: Type.Object({
          sessionManager: Type.Union([
            Type.Literal('ok'),
            Type.Literal('fail'),
          ]),
          transcriptionService: Type.Union([
            Type.Literal('ok'),
            Type.Literal('fail'),
          ]),
        }),
      },
      { description: 'One or more dependencies unreachable.' },
    ),
  },
} satisfies BaseRouteSchema;

const READINESS_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${NODE_SERVER_BASE_PATH}/probes/readiness`,
};

export { READINESS_SCHEMA, READINESS_ROUTE };
