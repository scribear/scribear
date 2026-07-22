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

const UNCANCEL_SESSION_SCHEMA = {
  description:
    'Reverse a cancel-session call ("Undo") by clearing canceledAt on a previously-canceled ' +
    'occurrence. Fails with 409 SLOT_NO_LONGER_AVAILABLE if another session now occupies the freed ' +
    'time range (e.g. an AUTO session backfilled it, or a new on-demand session was created there) — ' +
    'undo never silently creates an overlap.',
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
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
    409: Type.Object({
      code: Type.Literal('SLOT_NO_LONGER_AVAILABLE'),
      message: Type.String(),
    }),
    422: Type.Object({
      code: Type.Literal('SESSION_NOT_CANCELED'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const UNCANCEL_SESSION_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/schedule-management/uncancel-session`,
};

export { UNCANCEL_SESSION_SCHEMA, UNCANCEL_SESSION_ROUTE };
