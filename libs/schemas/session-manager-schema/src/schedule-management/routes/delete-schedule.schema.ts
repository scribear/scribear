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

const DELETE_SCHEDULE_SCHEMA = {
  description:
    'Close or hard-delete a session schedule. Schedules that have not yet started are hard-deleted; active or past schedules are closed at the last realized session end. Upcoming sessions are pruned in both cases.',
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    scheduleUid: Type.String({ format: 'uuid' }),
  }),
  response: {
    204: Type.Null({ description: 'Schedule deleted.' }),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('SCHEDULE_NOT_FOUND'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const DELETE_SCHEDULE_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/schedule-management/delete-schedule`,
};

export { DELETE_SCHEDULE_SCHEMA, DELETE_SCHEDULE_ROUTE };
