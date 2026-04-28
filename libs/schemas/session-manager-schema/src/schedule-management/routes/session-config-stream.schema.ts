import { Type } from 'typebox';

import {
  type BaseLongPollRouteSchema,
  type BaseRouteDefinition,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import {
  INVALID_SERVICE_KEY_REPLY_SCHEMA,
  SERVICE_API_KEY_AUTH_HEADER_SCHEMA,
  SERVICE_API_KEY_SECURITY,
} from '#src/shared/security/service-api-key.js';
import { SCHEDULE_MANAGEMENT_TAG } from '#src/tags.js';

import { SESSION_SCHEMA } from '../entities/session.schema.js';

const SESSION_CONFIG_STREAM_SCHEMA = {
  description:
    'Long-poll endpoint for Session Stream Server to track config changes on a single session. The server holds the request until `session_config_version` exceeds `sinceVersion`, then responds with the full updated session. 204 indicates no change within the server timeout — re-poll immediately with the same cursor.',
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: SERVICE_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: SERVICE_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  params: Type.Object({
    sessionUid: Type.String({ format: 'uuid' }),
  }),
  querystring: Type.Object({
    sinceVersion: Type.Integer({ minimum: 0 }),
  }),
  response: {
    200: SESSION_SCHEMA,
    204: Type.Null(),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_SERVICE_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('SESSION_NOT_FOUND'),
      message: Type.String(),
    }),
  },
} satisfies BaseLongPollRouteSchema;

const SESSION_CONFIG_STREAM_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/schedule-management/session-config-stream/:sessionUid`,
};

export { SESSION_CONFIG_STREAM_SCHEMA, SESSION_CONFIG_STREAM_ROUTE };
