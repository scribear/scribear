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
    'Create a recurring session schedule for a room. Returns the new schedule or a conflict error if it overlaps an existing one within the check horizon.',
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    roomUid: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    activeStart: Type.String({
      format: 'date-time',
      description:
        'UTC instant at which the schedule begins producing occurrences. Must be strictly in the future — schedules never produce occurrences in the past.',
    }),
    activeEnd: Type.Union([
      Type.String({
        format: 'date-time',
        description:
          'UTC instant after which the schedule produces no more occurrences. Null for indefinite.',
      }),
      Type.Null(),
    ]),
    localStartTime: LOCAL_TIME_SCHEMA,
    localEndTime: LOCAL_TIME_SCHEMA,
    frequency: SCHEDULE_FREQUENCY_SCHEMA,
    daysOfWeek: Type.Union([
      Type.Array(DAY_OF_WEEK_SCHEMA, {
        description: 'Required when frequency is WEEKLY or BIWEEKLY.',
      }),
      Type.Null(),
    ]),
    joinCodeScopes: Type.Array(SESSION_SCOPE_SCHEMA),
    transcriptionProviderId: Type.String(),
    transcriptionStreamConfig: Type.Unknown(),
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
      code: Type.Literal('CONFLICT'),
      message: Type.String(),
    }),
    422: Type.Object({
      code: Type.Literal('INVALID_ACTIVE_START'),
      message: Type.String(),
    }),
  },
} satisfies BaseRouteSchema;

const CREATE_SCHEDULE_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/schedule-management/create-schedule`,
};

export { CREATE_SCHEDULE_SCHEMA, CREATE_SCHEDULE_ROUTE };
