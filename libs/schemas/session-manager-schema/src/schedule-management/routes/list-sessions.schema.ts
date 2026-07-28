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
    'List sessions for a room whose effective interval overlaps the given time range. effectiveStart < to and (effectiveEnd > from or effectiveEnd is null). Ordered by effective start ascending. Includes ON_DEMAND and AUTO rows, which have no parent schedule and are therefore invisible to list-schedules.',
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: Type.Optional(ADMIN_API_KEY_AUTH_HEADER_SCHEMA),
  }),
  querystring: Type.Object({
    roomUid: Type.String({ format: 'uuid' }),
    from: Type.Optional(
      Type.String({
        format: 'date-time',
        description: 'Exclude sessions whose effective end is before this time.',
      }),
    ),
    to: Type.Optional(
      Type.String({
        format: 'date-time',
        description: 'Exclude sessions whose effective start is at or after this time.',
      }),
    ),
  }),
  response: {
    200: Type.Object({
      items: Type.Array(SESSION_SCHEMA),
    }),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('ROOM_NOT_FOUND'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const LIST_SESSIONS_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/schedule-management/list-sessions`,
};

export { LIST_SESSIONS_ROUTE, LIST_SESSIONS_SCHEMA };
