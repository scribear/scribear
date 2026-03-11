import Type from 'typebox';

export enum SessionTokenScope {
  RECEIVE_TRANSCRIPTIONS = 'RECEIVE_TRANSCRIPTIONS',
  SEND_AUDIO = 'SEND_AUDIO',
}

export const SESSION_TOKEN_PAYLOAD_SCHEMA = Type.Object({
  sessionId: Type.String(),
  scopes: Type.Array(Type.Enum(SessionTokenScope)),
  exp: Type.Number(),
});

export type SessionTokenPayload = Type.Static<
  typeof SESSION_TOKEN_PAYLOAD_SCHEMA
>;
