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

const DELETE_AUTO_SESSION_WINDOW_SCHEMA = {
  description:
    'Close or hard-delete an auto-session window. Windows that have not yet started are hard-deleted; active or past windows are closed at the current instant. AUTO sessions that were filling the window are pruned by the reconciler.',
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    windowUid: Type.String({ format: 'uuid' }),
  }),
  response: {
    204: Type.Null({ description: 'Window deleted.' }),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('WINDOW_NOT_FOUND'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const DELETE_AUTO_SESSION_WINDOW_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/schedule-management/delete-auto-session-window`,
};

export { DELETE_AUTO_SESSION_WINDOW_SCHEMA, DELETE_AUTO_SESSION_WINDOW_ROUTE };
