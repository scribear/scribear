import { type Static, Type } from 'typebox';

import { DAY_OF_WEEK_SCHEMA } from './day-of-week.schema.js';
import { LOCAL_TIME_SCHEMA } from './session-schedule.schema.js';

/**
 * An auto-session window as returned by schedule-management read endpoints.
 * `activeEnd` is `null` for indefinite windows. AUTO sessions are reconciled
 * to fill the gaps left by non-AUTO sessions within active window intervals.
 */
export const AUTO_SESSION_WINDOW_SCHEMA = Type.Object(
  {
    uid: Type.String({ format: 'uuid' }),
    roomUid: Type.String({ format: 'uuid' }),

    localStartTime: LOCAL_TIME_SCHEMA,
    localEndTime: LOCAL_TIME_SCHEMA,
    daysOfWeek: Type.Array(DAY_OF_WEEK_SCHEMA),

    transcriptionProviderId: Type.String(),
    transcriptionStreamConfig: Type.Unknown(),

    activeStart: Type.String({ format: 'date-time' }),
    activeEnd: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),

    createdAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'AutoSessionWindow' },
);

export type AutoSessionWindow = Static<typeof AUTO_SESSION_WINDOW_SCHEMA>;
