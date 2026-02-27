import Type from 'typebox';

import { ServerMessageTypes } from './server-message-types.js';

const IPTranscriptMessageSchema = Type.Object({
  type: Type.Literal(ServerMessageTypes.IP_TRANSCRIPT),
  text: Type.Array(Type.String()),
  starts: Type.Union([Type.Array(Type.Number()), Type.Null()]),
  ends: Type.Union([Type.Array(Type.Number()), Type.Null()]),
});
export { IPTranscriptMessageSchema };

export type IPTranscriptMessage = Type.Static<typeof IPTranscriptMessageSchema>;
