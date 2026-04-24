import { type Static, Type } from 'typebox';

/**
 * A room as returned by Session Manager read endpoints. Field names mirror the
 * database column names camel-cased.
 */
export const ROOM_SCHEMA = Type.Object(
  {
    uid: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    timezone: Type.String({
      description: 'IANA timezone identifier.',
      examples: ['America/New_York'],
    }),
    autoSessionEnabled: Type.Boolean(),
    autoSessionTranscriptionProviderId: Type.Union([
      Type.String(),
      Type.Null(),
    ]),
    autoSessionTranscriptionStreamConfig: Type.Union([
      Type.Unknown(),
      Type.Null(),
    ]),
    roomScheduleVersion: Type.Integer({
      description:
        'Monotonically increasing counter bumped on any session/schedule write in this room.',
    }),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'Room' },
);

export type Room = Static<typeof ROOM_SCHEMA>;

/**
 * The subset of room fields visible to the device itself via `DEVICE_TOKEN`
 * authentication. Fields like `autoSessionTranscriptionProviderId` or `createdAt` are omitted.
 */
export const SELF_ROOM_SCHEMA = Type.Object(
  {
    uid: Type.String({ format: 'uuid' }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    timezone: Type.String({
      description: 'IANA timezone identifier.',
      examples: ['America/New_York'],
    }),
    autoSessionEnabled: Type.Boolean(),
    roomScheduleVersion: Type.Integer({
      description:
        'Monotonically increasing counter bumped on any session/schedule write in this room.',
    }),
  },
  { $id: 'SelfRoom' },
);
