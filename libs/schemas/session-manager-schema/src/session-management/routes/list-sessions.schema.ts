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
import { paginatedQuerySchema } from '#src/shared/entities/pagination.schema.js';
import { SESSION_MANAGEMENT_TAG } from '#src/tags.js';

import { SESSION_TYPE_SCHEMA } from '../entities/session-type.schema.js';
import { SESSION_SCHEMA } from '../entities/session.schema.js';

const LIST_SESSIONS_SCHEMA = {
  description:
    'List sessions in a room within a time window. Includes server-computed state, startsInSeconds, and endsInSeconds fields so clients do not need to compare timestamps against their local clock.',
  tags: [SESSION_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  querystring: paginatedQuerySchema({
    roomUid: Type.String({ format: 'uuid' }),
    from: Type.Optional(
      Type.String({
        format: 'date-time',
        description:
          'Filter sessions with effective end >= from. Default: now() - 1 day.',
      }),
    ),
    to: Type.Optional(
      Type.String({
        format: 'date-time',
        description:
          'Filter sessions with effective start <= to. Default: now() + MATERIALIZATION_WINDOW.',
      }),
    ),
    type: Type.Optional(SESSION_TYPE_SCHEMA),
  }),
  response: {
    200: Type.Object({
      serverTime: Type.String({
        format: 'date-time',
        description: "Server's current time at response generation.",
      }),
      items: Type.Array(SESSION_SCHEMA),
      nextCursor: Type.Optional(Type.String()),
    }),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
  },
} satisfies BaseRouteSchema;

const LIST_SESSIONS_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/session-management/list-sessions`,
};

export { LIST_SESSIONS_SCHEMA, LIST_SESSIONS_ROUTE };
