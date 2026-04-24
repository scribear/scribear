import { Type } from 'typebox';

import type {
  BaseRouteDefinition,
  BaseRouteSchema,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import { PROBES_TAG } from '#src/tags.js';

const READINESS_SCHEMA = {
  description:
    'Readiness probe. Returns 200 when all dependencies (database) are reachable. Returns 503 when any dependency is down.',
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
          database: Type.Literal('fail'),
        }),
      },
      { description: 'One or more dependencies unreachable.' },
    ),
  },
} satisfies BaseRouteSchema;

const READINESS_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/probes/readiness`,
};

export { READINESS_SCHEMA, READINESS_ROUTE };
