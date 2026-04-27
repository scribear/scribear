import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import { ROOM_SCHEMA } from '#src/room-management/entities/room.schema.js';
import {
  ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  ADMIN_API_KEY_SECURITY,
  INVALID_ADMIN_KEY_REPLY_SCHEMA,
} from '#src/shared/security/admin-api-key.js';
import { SCHEDULE_MANAGEMENT_TAG } from '#src/tags.js';

const UPDATE_ROOM_SCHEDULE_CONFIG_SCHEMA = {
  description:
    'Update the schedule-related configuration of a room. Changing `timezone` triggers re-materialization of future scheduled sessions under the new timezone.',
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    roomUid: Type.String({ format: 'uuid' }),
    timezone: Type.Optional(Type.String()),
    autoSessionEnabled: Type.Optional(Type.Boolean()),
    autoSessionTranscriptionProviderId: Type.Optional(
      Type.Union([Type.String(), Type.Null()]),
    ),
    autoSessionTranscriptionStreamConfig: Type.Optional(
      Type.Union([Type.Unknown(), Type.Null()]),
    ),
  }),
  response: {
    200: ROOM_SCHEMA,
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('ROOM_NOT_FOUND'),
      message: Type.String(),
    }),
    422: Type.Object({
      code: Type.Literal('INVALID_TIMEZONE'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const UPDATE_ROOM_SCHEDULE_CONFIG_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/schedule-management/update-room-schedule-config`,
};

export {
  UPDATE_ROOM_SCHEDULE_CONFIG_SCHEMA,
  UPDATE_ROOM_SCHEDULE_CONFIG_ROUTE,
};
