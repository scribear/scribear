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
    "Toggle the room's autoSessionEnabled master switch. Atomically reconciles AUTO sessions: setting false drops all AUTO sessions (in-flight rows are ended via end_override; future rows deleted); setting true re-materializes AUTO sessions from existing active windows. If autoSessionEnabled is omitted or matches the current value, the call is a no-op. Room timezone is set at room creation and is immutable; it cannot be updated through this endpoint.",
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    roomUid: Type.String({ format: 'uuid' }),
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
