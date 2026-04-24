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

import { DAY_OF_WEEK_SCHEMA } from '../entities/day-of-week.schema.js';
import { SCHEDULE_FREQUENCY_SCHEMA } from '../entities/schedule-frequency.schema.js';
import {
  LOCAL_TIME_SCHEMA,
  SESSION_SCHEDULE_SCHEMA,
} from '../entities/session-schedule.schema.js';

const CREATE_SCHEDULE_SCHEMA = {
  description:
    'Create a session schedule. Materializes sessions within the upcoming window and recomputes auto sessions atomically.',
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    roomUid: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 256 }),

    activeStart: Type.String({ format: 'date-time' }),
    activeEnd: Type.Optional(
      Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    ),

    localStartTime: LOCAL_TIME_SCHEMA,
    localEndTime: LOCAL_TIME_SCHEMA,

    frequency: SCHEDULE_FREQUENCY_SCHEMA,
    daysOfWeek: Type.Optional(
      Type.Union([Type.Array(DAY_OF_WEEK_SCHEMA), Type.Null()]),
    ),

    joinCodeScopes: Type.Optional(Type.Array(SESSION_SCOPE_SCHEMA)),
    transcriptionProviderId: Type.String(),
    transcriptionStreamConfig: Type.Object({}),
  }),
  response: {
    201: SESSION_SCHEDULE_SCHEMA,
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('ROOM_NOT_FOUND'),
      message: Type.String(),
    }),
    409: Type.Object({
      code: Type.Literal('SCHEDULE_CONFLICT'),
      message: Type.String(),
      details: Type.Optional(
        Type.Object({
          conflictingSessionUid: Type.String({ format: 'uuid' }),
        }),
      ),
    }),
  },
} satisfies BaseRouteSchema;

const CREATE_SCHEDULE_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/session-management/create-schedule`,
};

export { CREATE_SCHEDULE_SCHEMA, CREATE_SCHEDULE_ROUTE };
