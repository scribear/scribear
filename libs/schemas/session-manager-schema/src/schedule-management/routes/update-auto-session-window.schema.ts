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
import { SCHEDULE_MANAGEMENT_TAG } from '#src/tags.js';

import { AUTO_SESSION_WINDOW_SCHEMA } from '../entities/auto-session-window.schema.js';
import { DAY_OF_WEEK_SCHEMA } from '../entities/day-of-week.schema.js';
import { LOCAL_TIME_SCHEMA } from '../entities/session-schedule.schema.js';

const UPDATE_AUTO_SESSION_WINDOW_SCHEMA = {
  description:
    'Update an open auto-session window by closing the existing row at the current instant and re-inserting with merged fields. The window must be open (activeEnd is null).',
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    windowUid: Type.String({ format: 'uuid' }),
    localStartTime: Type.Optional(LOCAL_TIME_SCHEMA),
    localEndTime: Type.Optional(LOCAL_TIME_SCHEMA),
    daysOfWeek: Type.Optional(
      Type.Array(DAY_OF_WEEK_SCHEMA, { minItems: 1, uniqueItems: true }),
    ),
    activeStart: Type.Optional(Type.String({ format: 'date-time' })),
    activeEnd: Type.Optional(
      Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    ),
    transcriptionProviderId: Type.Optional(Type.String()),
    transcriptionStreamConfig: Type.Optional(Type.Unknown()),
  }),
  response: {
    200: AUTO_SESSION_WINDOW_SCHEMA,
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('WINDOW_NOT_FOUND'),
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

const UPDATE_AUTO_SESSION_WINDOW_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/schedule-management/update-auto-session-window`,
};

export { UPDATE_AUTO_SESSION_WINDOW_SCHEMA, UPDATE_AUTO_SESSION_WINDOW_ROUTE };
