import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import { SESSION_SCOPE_SCHEMA } from '#src/shared/entities/session-scope.schema.js';
import {
  DEVICE_TOKEN_SECURITY,
  INVALID_DEVICE_TOKEN_REPLY_SCHEMA,
} from '#src/shared/security/device-token.js';
import { SESSION_AUTH_TAG } from '#src/tags.js';

const EXCHANGE_DEVICE_TOKEN_SCHEMA = {
  description:
    'Exchange a DEVICE_TOKEN cookie for a short-lived session token. Source devices receive SEND_AUDIO + RECEIVE_TRANSCRIPTIONS; non-source devices receive RECEIVE_TRANSCRIPTIONS only.',
  tags: [SESSION_AUTH_TAG],
  security: DEVICE_TOKEN_SECURITY,
  body: Type.Object({
    sessionUid: Type.String({ format: 'uuid' }),
  }),
  response: {
    200: Type.Object({
      sessionToken: Type.String(),
      sessionTokenExpiresAt: Type.String({ format: 'date-time' }),
      scopes: Type.Array(SESSION_SCOPE_SCHEMA),
    }),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_DEVICE_TOKEN_REPLY_SCHEMA,
    403: Type.Object({
      code: Type.Literal('DEVICE_NOT_IN_SESSION_ROOM'),
      message: Type.String(),
    }),
    404: Type.Object({
      code: Type.Literal('SESSION_NOT_FOUND'),
      message: Type.String(),
    }),
    409: Type.Object({
      code: Type.Literal('SESSION_NOT_CURRENTLY_ACTIVE'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const EXCHANGE_DEVICE_TOKEN_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/session-auth/exchange-device-token`,
};

export { EXCHANGE_DEVICE_TOKEN_SCHEMA, EXCHANGE_DEVICE_TOKEN_ROUTE };
