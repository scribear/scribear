import { type Static, Type } from 'typebox';

export const AUTH_METHOD_SCHEMA = Type.Union(
  [Type.Literal('JOIN_CODE'), Type.Literal('DEVICE_TOKEN')],
  { $id: 'AuthMethod' },
);

export type AuthMethod = Static<typeof AUTH_METHOD_SCHEMA>;
