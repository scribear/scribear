import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseRouteSchema,
  STANDARD_ERROR_REPLIES,
} from '@scribear/base-schema';

import { SESSION_MANAGER_BASE_PATH } from '#src/base-path.js';
import { SESSION_SCOPE_SCHEMA } from '#src/shared/entities/session-scope.schema.js';
import {
  ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  ADMIN_API_KEY_SECURITY,
  INVALID_ADMIN_KEY_REPLY_SCHEMA,
} from '#src/shared/security/admin-api-key.js';
import { SCHEDULE_MANAGEMENT_TAG } from '#src/tags.js';

import { AUTO_SESSION_WINDOW_SCHEMA } from '../entities/auto-session-window.schema.js';
import { DAY_OF_WEEK_SCHEMA } from '../entities/day-of-week.schema.js';
import { LOCAL_TIME_SCHEMA } from '../entities/session-schedule.schema.js';

const CREATE_AUTO_SESSION_WINDOW_SCHEMA = {
  description:
    'Create an auto-session window for a room. AUTO sessions are reconciled to fill gaps left by non-AUTO sessions within the window interval. Returns a conflict error if the window overlaps an existing one.',
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    roomUid: Type.String({ format: 'uuid' }),
    localStartTime: LOCAL_TIME_SCHEMA,
    localEndTime: LOCAL_TIME_SCHEMA,
    daysOfWeek: Type.Array(DAY_OF_WEEK_SCHEMA, {
      minItems: 1,
      uniqueItems: true,
    }),
    activeStart: Type.String({ format: 'date-time' }),
    activeEnd: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    joinCodeScopes: Type.Array(SESSION_SCOPE_SCHEMA),
    transcriptionProviderId: Type.String(),
    transcriptionStreamConfig: Type.Unknown(),
  }),
  response: {
    201: AUTO_SESSION_WINDOW_SCHEMA,
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('ROOM_NOT_FOUND'),
      message: Type.String(),
    }),
    409: Type.Object({
      code: Type.Literal('CONFLICT'),
      message: Type.String(),
    }),
    422: Type.Object({
      code: Type.Literal('INVALID_ACTIVE_END'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const CREATE_AUTO_SESSION_WINDOW_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/schedule-management/create-auto-session-window`,
};

export { CREATE_AUTO_SESSION_WINDOW_SCHEMA, CREATE_AUTO_SESSION_WINDOW_ROUTE };
