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

const GET_SESSION_SCHEMA = {
  description: 'Fetch a single session by its UID.',
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  params: Type.Object({
    sessionUid: Type.String({ format: 'uuid' }),
  }),
  response: {
    200: SESSION_SCHEMA,
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('SESSION_NOT_FOUND'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const GET_SESSION_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/schedule-management/get-session/:sessionUid`,
};

export { GET_SESSION_SCHEMA, GET_SESSION_ROUTE };
