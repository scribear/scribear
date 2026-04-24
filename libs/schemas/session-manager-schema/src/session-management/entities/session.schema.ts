import { type Static, Type } from 'typebox';

import { SESSION_SCOPE_SCHEMA } from '#src/shared/entities/session-scope.schema.js';

import { SESSION_TYPE_SCHEMA } from './session-type.schema.js';

/**
 * Derived state label computed by the server from the session's timestamps.
 * Clients should prefer `state` + `startsInSeconds` / `endsInSeconds` over
 * comparing absolute timestamps against their local clock.
 */
export const SESSION_STATE_SCHEMA = Type.Union(
  [Type.Literal('UPCOMING'), Type.Literal('ACTIVE'), Type.Literal('ENDED')],
  { $id: 'SessionState' },
);

export type SessionState = Static<typeof SESSION_STATE_SCHEMA>;

/**
 * A materialized session. `startOverride` and `endOverride` are populated only
 * when an admin action moved the actual boundary away from the scheduled time.
 */
export const SESSION_SCHEMA = Type.Object(
  {
    uid: Type.String({ format: 'uuid' }),
    roomUid: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    type: SESSION_TYPE_SCHEMA,

    scheduledSessionUid: Type.Union([
      Type.String({ format: 'uuid' }),
      Type.Null(),
    ]),

    scheduledStartTime: Type.String({ format: 'date-time' }),
    scheduledEndTime: Type.Union([
      Type.String({ format: 'date-time' }),
      Type.Null(),
    ]),
    startOverride: Type.Union([
      Type.String({ format: 'date-time' }),
      Type.Null(),
    ]),
    endOverride: Type.Union([
      Type.String({ format: 'date-time' }),
      Type.Null(),
    ]),

    effectiveStart: Type.String({
      format: 'date-time',
      description: 'COALESCE(startOverride, scheduledStartTime).',
    }),
    effectiveEnd: Type.Union([
      Type.String({ format: 'date-time' }),
      Type.Null(),
    ]),

    state: SESSION_STATE_SCHEMA,
    startsInSeconds: Type.Union([Type.Integer(), Type.Null()]),
    endsInSeconds: Type.Union([Type.Integer(), Type.Null()]),

    joinCodeScopes: Type.Array(SESSION_SCOPE_SCHEMA),
    transcriptionProviderId: Type.Union([Type.String(), Type.Null()]),
    transcriptionStreamConfig: Type.Union([Type.Unknown(), Type.Null()]),

    sessionConfigVersion: Type.Integer(),

    createdAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'Session' },
);

export type Session = Static<typeof SESSION_SCHEMA>;
