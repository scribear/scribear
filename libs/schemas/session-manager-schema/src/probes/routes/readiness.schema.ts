import { Type } from 'typebox';

import type {
  BaseRouteDefinition,
  BaseRouteSchema,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import { PROBES_TAG } from '#src/tags.js';

/**
 * One dependency's verdict. Both keys are always present in a 503 body, so the
 * report distinguishes "the database is down" from "the database is fine and its
 * schema is behind this build" - two different operator problems that used to be
 * indistinguishable, because `database: fail` was the only thing this route
 * could say.
 */
const CHECK_STATUS = Type.Union([Type.Literal('ok'), Type.Literal('fail')]);

const READINESS_SCHEMA = {
  description:
    'Readiness probe. Returns 200 when the database is reachable and its schema is at least as new as this build expects. Returns 503 otherwise.',
  tags: [PROBES_TAG],
  response: {
    200: Type.Object(
      { status: Type.Literal('ok') },
      { description: 'All dependencies reachable and the schema is current.' },
    ),
    503: Type.Object(
      {
        status: Type.Literal('fail'),
        checks: Type.Object({
          database: CHECK_STATUS,
          /**
           * `fail` when migrations this build ships have not been applied.
           * Deliberately *not* a failure when the database is ahead of this
           * build: that is what a rollback looks like, and refusing to serve
           * would turn it into an outage.
           */
          schema: CHECK_STATUS,
        }),
      },
      { description: 'A dependency is unreachable, or the schema is behind.' },
    ),
  },
} satisfies BaseRouteSchema;

const READINESS_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/probes/readiness`,
};

export { READINESS_SCHEMA, READINESS_ROUTE };
