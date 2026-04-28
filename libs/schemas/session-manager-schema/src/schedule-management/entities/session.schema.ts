import { type Static, Type } from 'typebox';

import { SESSION_SCOPE_SCHEMA } from '#src/shared/entities/session-scope.schema.js';

import { SESSION_TYPE_SCHEMA } from './session-type.schema.js';

/**
 * A session as returned by schedule-management read endpoints. Includes
 * precomputed `effectiveStart` / `effectiveEnd` convenience fields.
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
      Type.String({
        format: 'date-time',
        description: 'COALESCE(endOverride, scheduledEndTime).',
      }),
      Type.Null(),
    ]),

    joinCodeScopes: Type.Array(SESSION_SCOPE_SCHEMA),
    transcriptionProviderId: Type.String(),
    transcriptionStreamConfig: Type.Unknown(),

    sessionConfigVersion: Type.Integer({
      description:
        'Monotonically increasing counter bumped on every config change to this session.',
    }),

    createdAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'Session' },
);

export type Session = Static<typeof SESSION_SCHEMA>;
