import { Type } from 'typebox';

import {
  type BaseLongPollRouteSchema,
  type BaseRouteDefinition,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import {
  ADMIN_OR_SERVICE_SECURITY,
  INVALID_ADMIN_KEY_REPLY_SCHEMA,
  INVALID_SERVICE_KEY_REPLY_SCHEMA,
} from '#src/shared/security/index.js';
import { SESSION_SCOPE_SCHEMA } from '#src/shared/entities/session-scope.schema.js';
import { SESSION_MANAGEMENT_TAG } from '#src/tags.js';

const SESSION_CONFIG_SCHEMA = {
  description:
    "Long-poll endpoint returning a session's transcription configuration. The server holds the request until `sessionConfigVersion` exceeds `sinceVersion`, then responds with the full config. 204 indicates no change within the server timeout - re-poll immediately with the same cursor. Consumed by Session Stream Server instances to detect config changes without a separate notification stream. Accepts ADMIN_API_KEY or SESSION_MANAGER_SERVICE_API_KEY; DEVICE_TOKEN is not accepted.",
  tags: [SESSION_MANAGEMENT_TAG],
  security: ADMIN_OR_SERVICE_SECURITY,
  params: Type.Object({
    sessionUid: Type.String({ format: 'uuid' }),
  }),
  querystring: Type.Object({
    sinceVersion: Type.Integer({ minimum: 0 }),
  }),
  response: {
    200: Type.Object(
      {
        sessionUid: Type.String({ format: 'uuid' }),
        sessionConfigVersion: Type.Integer(),
        transcriptionProviderId: Type.Union([Type.String(), Type.Null()]),
        transcriptionStreamConfig: Type.Union([Type.Unknown(), Type.Null()]),
        joinCodeScopes: Type.Array(SESSION_SCOPE_SCHEMA),
      },
      { $id: 'SessionConfigResponse' },
    ),
    204: Type.Null(),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    ...INVALID_SERVICE_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('SESSION_NOT_FOUND'),
      message: Type.String(),
    }),
  },
} satisfies BaseLongPollRouteSchema;

const SESSION_CONFIG_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/session-management/session-config/:sessionUid`,
};

export { SESSION_CONFIG_SCHEMA, SESSION_CONFIG_ROUTE };
