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

import { AUTO_SESSION_WINDOW_SCHEMA } from '../entities/auto-session-window.schema.js';

const LIST_AUTO_SESSION_WINDOWS_SCHEMA = {
  description:
    'List auto-session windows for a room that are active within the given time range. Returns windows where activeStart <= to and (activeEnd >= from or activeEnd is null).',
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  querystring: Type.Object({
    roomUid: Type.String({ format: 'uuid' }),
    from: Type.Optional(
      Type.String({
        format: 'date-time',
        description: 'Exclude windows whose activeEnd is before this time.',
      }),
    ),
    to: Type.Optional(
      Type.String({
        format: 'date-time',
        description: 'Exclude windows whose activeStart is after this time.',
      }),
    ),
  }),
  response: {
    200: Type.Object({
      items: Type.Array(AUTO_SESSION_WINDOW_SCHEMA),
    }),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('ROOM_NOT_FOUND'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const LIST_AUTO_SESSION_WINDOWS_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/schedule-management/list-auto-session-windows`,
};

export { LIST_AUTO_SESSION_WINDOWS_SCHEMA, LIST_AUTO_SESSION_WINDOWS_ROUTE };
