import { Type } from 'typebox';

import {
  type BaseLongPollRouteSchema,
  type BaseRouteDefinition,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import {
  DEVICE_TOKEN_SECURITY,
  INVALID_DEVICE_TOKEN_REPLY_SCHEMA,
} from '#src/shared/security/device-token.js';
import { SESSION_SCHEMA } from '#src/session-management/entities/session.schema.js';
import { ROOM_MANAGEMENT_TAG } from '#src/tags.js';

const MY_SCHEDULE_SCHEMA = {
  description:
    "Long-poll endpoint returning the device's current room schedule. The server holds the request until `roomScheduleVersion` exceeds `sinceVersion`, then responds with the full session list. 204 indicates no change within the server timeout - re-poll immediately with the same cursor. Responds with a new `roomUid` and schedule if the device is reassigned to a different room while polling. Returns 404 if the device is unassigned from all rooms.",
  tags: [ROOM_MANAGEMENT_TAG],
  security: DEVICE_TOKEN_SECURITY,
  querystring: Type.Object({
    sinceVersion: Type.Integer({ minimum: 0 }),
  }),
  response: {
    200: Type.Object({
      roomUid: Type.String({ format: 'uuid' }),
      roomScheduleVersion: Type.Integer(),
      serverTime: Type.String({
        format: 'date-time',
        description:
          "Server's current time, for client-side relative-time calculations.",
      }),
      sessions: Type.Array(SESSION_SCHEMA),
    }),
    204: Type.Null(),
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_DEVICE_TOKEN_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('DEVICE_NOT_IN_ROOM'),
      message: Type.String(),
    }),
  },
} satisfies BaseLongPollRouteSchema;

const MY_SCHEDULE_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  url: `${SESSION_MANAGER_BASE_PATH}/room-management/my-schedule`,
};

export { MY_SCHEDULE_SCHEMA, MY_SCHEDULE_ROUTE };
