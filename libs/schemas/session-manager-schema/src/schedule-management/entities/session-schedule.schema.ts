import { type Static, Type } from 'typebox';

import { SESSION_SCOPE_SCHEMA } from '#src/shared/entities/session-scope.schema.js';

import { DAY_OF_WEEK_SCHEMA } from './day-of-week.schema.js';
import { SCHEDULE_FREQUENCY_SCHEMA } from './schedule-frequency.schema.js';

const LOCAL_TIME_SCHEMA = Type.String({
  maxLength: 8,
  pattern: '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$',
  description:
    "Wall-clock time of day in the room's timezone (HH:MM or HH:MM:SS).",
  examples: ['14:00', '14:00:00'],
});

/**
 * A session schedule as returned by read endpoints. `activeEnd` is `null` for
 * indefinite schedules. If `localEndTime < localStartTime`, each occurrence
 * wraps past midnight into the following day.
 */
export const SESSION_SCHEDULE_SCHEMA = Type.Object(
  {
    uid: Type.String({ format: 'uuid' }),
    roomUid: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 256 }),

    activeStart: Type.String({ format: 'date-time' }),
    activeEnd: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
    anchorStart: Type.String({
      format: 'date-time',
      description:
        "BIWEEKLY parity reference. Equals the schedule's original activeStart; preserved verbatim across updates so the biweekly cadence does not shift.",
    }),

    localStartTime: LOCAL_TIME_SCHEMA,
    localEndTime: LOCAL_TIME_SCHEMA,

    frequency: SCHEDULE_FREQUENCY_SCHEMA,
    daysOfWeek: Type.Union([Type.Array(DAY_OF_WEEK_SCHEMA), Type.Null()]),

    joinCodeScopes: Type.Array(SESSION_SCOPE_SCHEMA),
    transcriptionProviderId: Type.Union([Type.String(), Type.Null()]),
    transcriptionStreamConfig: Type.Union([Type.Unknown(), Type.Null()]),

    createdAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'SessionSchedule' },
);

export type SessionSchedule = Static<typeof SESSION_SCHEDULE_SCHEMA>;

export { LOCAL_TIME_SCHEMA };
