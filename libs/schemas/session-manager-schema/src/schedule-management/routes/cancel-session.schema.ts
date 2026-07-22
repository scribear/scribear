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

const CANCEL_SESSION_SCHEMA = {
  description:
    'Cancel a single upcoming SCHEDULED session occurrence without affecting its parent schedule ' +
    'or any other occurrence. Only upcoming SCHEDULED sessions can be canceled — AUTO and ON_DEMAND ' +
    'sessions are rejected. If an active auto-session window covers the freed time, an AUTO session ' +
    'may be materialized to fill the gap. Editing or deleting the parent schedule later will ' +
    'supersede this cancellation.',
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
    422: Type.Union([
      Type.Object({
        code: Type.Literal('SESSION_NOT_SCHEDULED_TYPE'),
        message: Type.String(),
      }),
      Type.Object({
        code: Type.Literal('SESSION_ALREADY_CANCELED'),
        message: Type.String(),
      }),
      Type.Object({
        code: Type.Literal('SESSION_NOT_UPCOMING'),
        message: Type.String(),
      }),
    ]),
  },
} satisfies BaseRouteSchema;

const CANCEL_SESSION_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/schedule-management/cancel-session`,
};

export { CANCEL_SESSION_SCHEMA, CANCEL_SESSION_ROUTE };
