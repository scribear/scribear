import { type Static, Type } from 'typebox';

export const SESSION_TYPE_SCHEMA = Type.Union(
  [Type.Literal('SCHEDULED'), Type.Literal('ON_DEMAND'), Type.Literal('AUTO')],
  { $id: 'SessionType' },
);

export type SessionType = Static<typeof SESSION_TYPE_SCHEMA>;
