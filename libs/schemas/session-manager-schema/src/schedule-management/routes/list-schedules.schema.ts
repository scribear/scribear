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
import { SCHEDULE_MANAGEMENT_TAG } from '#src/tags.js';

import { SESSION_SCHEDULE_SCHEMA } from '../entities/session-schedule.schema.js';

const LIST_SCHEDULES_SCHEMA = {
  description:
    'List session schedules for a room, optionally filtered by name.',
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  querystring: paginatedQuerySchema({
    roomUid: Type.String({ format: 'uuid' }),
    search: Type.Optional(
      Type.String({
        description: 'Fuzzy name filter using trigram similarity.',
      }),
    ),
  }),
  response: {
    200: Type.Object({
      items: Type.Array(SESSION_SCHEDULE_SCHEMA),
      nextCursor: Type.Optional(Type.String()),
    }),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
  },
} satisfies BaseRouteSchema;

const LIST_SCHEDULES_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/session-management/list-schedules`,
};

export { LIST_SCHEDULES_SCHEMA, LIST_SCHEDULES_ROUTE };
