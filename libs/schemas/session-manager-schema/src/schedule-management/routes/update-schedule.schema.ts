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

const UPDATE_SCHEDULE_SCHEMA = {
  description:
    "Update an open schedule by closing it at the current instant and re-inserting a new row with the merged fields. Past sessions are preserved; future occurrences are re-materialized. The schedule must be open (activeEnd is null). The merged activeStart must be strictly in the future - when updating a schedule that has already taken effect, the caller must explicitly supply a future activeStart. The schedule's BIWEEKLY anchor is preserved verbatim across updates so cadence does not shift.",
  tags: [SCHEDULE_MANAGEMENT_TAG],
  security: ADMIN_API_KEY_SECURITY,
  headers: Type.Object({
    authorization: ADMIN_API_KEY_AUTH_HEADER_SCHEMA,
  }),
  body: Type.Object({
    scheduleUid: Type.String({ format: 'uuid' }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    activeStart: Type.Optional(Type.String({ format: 'date-time' })),
    activeEnd: Type.Optional(
      Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    ),
    localStartTime: Type.Optional(LOCAL_TIME_SCHEMA),
    localEndTime: Type.Optional(LOCAL_TIME_SCHEMA),
    frequency: Type.Optional(SCHEDULE_FREQUENCY_SCHEMA),
    daysOfWeek: Type.Optional(
      Type.Union([
        Type.Array(DAY_OF_WEEK_SCHEMA, { uniqueItems: true }),
        Type.Null(),
      ]),
    ),
    joinCodeScopes: Type.Optional(Type.Array(SESSION_SCOPE_SCHEMA)),
    transcriptionProviderId: Type.Optional(Type.String()),
    transcriptionStreamConfig: Type.Optional(Type.Unknown()),
  }),
  response: {
    200: SESSION_SCHEDULE_SCHEMA,
    ...STANDARD_ERROR_REPLIES,
    ...INVALID_ADMIN_KEY_REPLY_SCHEMA,
    404: Type.Object({
      code: Type.Literal('SCHEDULE_NOT_FOUND'),
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

const UPDATE_SCHEDULE_ROUTE: BaseRouteDefinition = {
  method: 'POST',
  url: `${SESSION_MANAGER_BASE_PATH}/schedule-management/update-schedule`,
};

export { UPDATE_SCHEDULE_SCHEMA, UPDATE_SCHEDULE_ROUTE };
