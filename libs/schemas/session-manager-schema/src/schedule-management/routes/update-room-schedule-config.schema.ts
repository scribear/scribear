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
import { ROOM_SCHEMA } from '#src/room-management/entities/room.schema.js';
import { SCHEDULE_MANAGEMENT_TAG } from '#src/tags.js';

const UPDATE_ROOM_SCHEDULE_CONFIG_SCHEMA = {
  description:
    'Update schedule-affecting room configuration. Timezone changes atomically delete future SCHEDULED sessions and re-expand all open schedules under the new zone. Toggling autoSessionEnabled either drops all AUTO sessions (false) or re-materializes them from existing windows (true). If neither field is provided or both match the current values, the call is a no-op.',
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    roomUid: Type.String({ format: 'uuid' }),
    timezone: Type.Optional(
      Type.String({
        description: 'IANA timezone identifier.',
        examples: ['America/New_York'],
      }),
    ),
    autoSessionEnabled: Type.Optional(
      Type.Boolean({
        description:
          "Master switch for the room's auto sessions. When false, all AUTO sessions are removed regardless of active windows.",
      }),
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

export { UPDATE_ROOM_SCHEDULE_CONFIG_SCHEMA, UPDATE_ROOM_SCHEDULE_CONFIG_ROUTE };
