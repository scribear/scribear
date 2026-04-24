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
    'Delete a schedule whose first occurrence has not yet started. Use update-schedule with activeEnd to stop a schedule that has produced active or ended sessions.',
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
    409: Type.Object({
      code: Type.Literal('SCHEDULE_ALREADY_STARTED'),
      message: Type.String(),
      details: Type.Optional(
        Type.Object({
          conflictingSessionUid: Type.String({ format: 'uuid' }),
        }),
      ),
    }),
  },
} satisfies BaseRouteSchema;

const DELETE_SCHEDULE_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/session-management/delete-schedule`,
};

export { DELETE_SCHEDULE_SCHEMA, DELETE_SCHEDULE_ROUTE };
