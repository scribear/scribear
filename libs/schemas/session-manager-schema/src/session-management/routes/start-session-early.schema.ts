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

const START_SESSION_EARLY_SCHEMA = {
  description:
    'Start the next upcoming session before its scheduled start time. Rejected if another session is currently active or if the target is not the next upcoming session.',
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
        code: Type.Literal('NOT_NEXT_UPCOMING'),
        message: Type.String(),
      }),
      Type.Object({
        code: Type.Literal('ANOTHER_SESSION_ACTIVE'),
        message: Type.String(),
      }),
      Type.Object({
        code: Type.Literal('SESSION_IS_AUTO'),
        message: Type.String(),
      }),
    ]),
  },
} satisfies BaseRouteSchema;

const START_SESSION_EARLY_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/session-management/start-session-early`,
};

export { START_SESSION_EARLY_SCHEMA, START_SESSION_EARLY_ROUTE };
