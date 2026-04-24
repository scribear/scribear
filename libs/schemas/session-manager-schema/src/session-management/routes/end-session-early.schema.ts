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
import { SESSION_MANAGEMENT_TAG } from '#src/tags.js';

import { SESSION_SCHEMA } from '../entities/session.schema.js';

const END_SESSION_EARLY_SCHEMA = {
  description:
    'End a currently active session before its scheduled end time. Connected clients receive SESSION_END. Auto sessions cannot be ended early - disable autoSessionEnabled on the room instead.',
  tags: [SESSION_MANAGEMENT_TAG],
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
    409: Type.Union([
      Type.Object({
        code: Type.Literal('SESSION_NOT_ACTIVE'),
        message: Type.String(),
      }),
      Type.Object({
        code: Type.Literal('SESSION_IS_AUTO'),
        message: Type.String(),
      }),
    ]),
  },
} satisfies BaseRouteSchema;

const END_SESSION_EARLY_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/session-management/end-session-early`,
};

export { END_SESSION_EARLY_SCHEMA, END_SESSION_EARLY_ROUTE };
