import { type Static, Type } from 'typebox';

export const SESSION_SCOPE_SCHEMA = Type.Union(
  [Type.Literal('SEND_AUDIO'), Type.Literal('RECEIVE_TRANSCRIPTIONS')],
  { $id: 'SessionScope' },
);

export type SessionScope = Static<typeof SESSION_SCOPE_SCHEMA>;
