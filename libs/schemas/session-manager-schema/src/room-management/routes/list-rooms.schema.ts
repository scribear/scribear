import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import { paginatedQuerySchema } from '#src/shared/entities/pagination.schema.js';
import {
  ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  ADMIN_API_KEY_SECURITY,
  INVALID_ADMIN_KEY_REPLY_SCHEMA,
} from '#src/shared/security/admin-api-key.js';
import { ROOM_MANAGEMENT_TAG } from '#src/tags.js';

import { ROOM_SCHEMA } from '../entities/room.schema.js';

const LIST_ROOMS_SCHEMA = {
  description:
    'List rooms, optionally filtered by a trigram-similarity search on name. Results are paginated.',
  tags: [ROOM_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  querystring: paginatedQuerySchema({
    search: Type.Optional(
      Type.String({
        description:
          'Fuzzy substring to match against room name using trigram similarity.',
      }),
    ),
  }),
  response: {
    200: Type.Object(
      {
        items: Type.Array(ROOM_SCHEMA),
        nextCursor: Type.Union([Type.String(), Type.Null()]),
      },
      { description: 'Paginated rooms matching the optional search filter.' },
    ),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
  },
} satisfies BaseRouteSchema;

const LIST_ROOMS_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/room-management/list-rooms`,
};

export { LIST_ROOMS_SCHEMA, LIST_ROOMS_ROUTE };
