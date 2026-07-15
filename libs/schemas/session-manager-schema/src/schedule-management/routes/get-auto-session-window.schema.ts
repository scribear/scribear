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

const GET_AUTO_SESSION_WINDOW_SCHEMA = {
  description: 'Fetch a single auto-session window by its UID.',
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  params: Type.Object({
    windowUid: Type.String({ format: 'uuid' }),
  }),
  response: {
    200: AUTO_SESSION_WINDOW_SCHEMA,
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('WINDOW_NOT_FOUND'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const GET_AUTO_SESSION_WINDOW_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/schedule-management/get-auto-session-window/:windowUid`,
};

export { GET_AUTO_SESSION_WINDOW_SCHEMA, GET_AUTO_SESSION_WINDOW_ROUTE };
