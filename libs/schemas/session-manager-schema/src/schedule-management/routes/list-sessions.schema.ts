import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import {
  ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  ADMIN_API_KEY_SECURITY,
  INVALID_ADMIN_KEY_REPLY_SCHEMA,
} from '#src/shared/security/admin-api-key.js';
import { SCHEDULE_MANAGEMENT_TAG } from '#src/tags.js';

import { SESSION_SCHEMA } from '../entities/session.schema.js';

const LIST_SESSIONS_SCHEMA = {
  description:
    'List materialized sessions across one or more rooms within a date range, for calendar views. ' +
    'If roomUids is omitted, sessions across ALL rooms are returned. Includes canceled sessions ' +
    '(canceledAt set) so callers can render cancellation history; callers that need "is this slot ' +
    'actually occupied" semantics must filter canceledAt themselves. The range (to - from) must not ' +
    'exceed 31 days.',
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  querystring: Type.Object({
    // Fastify's querystring parser yields a bare string for a single
    // `?roomUids=a` occurrence and only an array for repeated occurrences
    // (`?roomUids=a&roomUids=b`) — accept both shapes here and normalize to
    // an array in the controller.
    roomUids: Type.Optional(
      Type.Union(
        [
          Type.String({ format: 'uuid' }),
          Type.Array(Type.String({ format: 'uuid' })),
        ],
        {
          description:
            'Restrict results to these rooms. Pass the query key once per room ' +
            '(?roomUids=a&roomUids=b). Omit entirely to list sessions across all rooms.',
        },
      ),
    ),
    from: Type.String({
      format: 'date-time',
      description: 'Include sessions whose effective end is after this time.',
    }),
    to: Type.String({
      format: 'date-time',
      description:
        'Include sessions whose effective start is before this time.',
    }),
  }),
  response: {
    200: Type.Object({
      items: Type.Array(SESSION_SCHEMA),
    }),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    422: Type.Object({
      code: Type.Literal('RANGE_TOO_LARGE'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const LIST_SESSIONS_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/schedule-management/list-sessions`,
};

export { LIST_SESSIONS_SCHEMA, LIST_SESSIONS_ROUTE };
