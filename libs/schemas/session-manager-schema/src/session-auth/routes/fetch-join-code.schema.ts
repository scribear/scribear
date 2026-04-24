import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import {
  DEVICE_TOKEN_SECURITY,
  INVALID_DEVICE_TOKEN_REPLY_SCHEMA,
} from '#src/shared/security/device-token.js';
import { SESSION_AUTH_TAG } from '#src/tags.js';

const JOIN_CODE_INFO_SCHEMA = Type.Object(
  {
    joinCode: Type.String({
      description: '8-character alphanumeric code in the format XXXXXXXX.',
    }),
    validStart: Type.String({ format: 'date-time' }),
    validEnd: Type.String({ format: 'date-time' }),
  },
  { $id: 'JoinCodeInfo' },
);

const FETCH_JOIN_CODE_SCHEMA = {
  description:
    'Fetch the current and next join codes for a session. Returns up to two codes so the device can display the upcoming code before handoff. Idempotent - existing valid codes are returned as-is.',
  tags: [SESSION_AUTH_TAG],
  security: DEVICE_TOKEN_SECURITY,
  body: Type.Object({
    sessionUid: Type.String({ format: 'uuid' }),
  }),
  response: {
    200: Type.Object({
      current: JOIN_CODE_INFO_SCHEMA,
      next: Type.Union([JOIN_CODE_INFO_SCHEMA, Type.Null()]),
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
      code: Type.Literal('JOIN_CODE_SCOPES_EMPTY'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const FETCH_JOIN_CODE_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/session-auth/fetch-join-code`,
};

export { FETCH_JOIN_CODE_SCHEMA, FETCH_JOIN_CODE_ROUTE, JOIN_CODE_INFO_SCHEMA };
