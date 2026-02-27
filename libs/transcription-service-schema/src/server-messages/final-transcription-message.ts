import Type from 'typebox';

import { ServerMessageTypes } from './server-message-types.js';

const FinalTranscriptMessageSchema = Type.Object({
  type: Type.Literal(ServerMessageTypes.FINAL_TRANSCRIPT),
  text: Type.Array(Type.String()),
  starts: Type.Union([Type.Array(Type.Number()), Type.Null()]),
  ends: Type.Union([Type.Array(Type.Number()), Type.Null()]),
});
export { FinalTranscriptMessageSchema };

export type FinalTranscriptMessage = Type.Static<
  typeof FinalTranscriptMessageSchema
>;
