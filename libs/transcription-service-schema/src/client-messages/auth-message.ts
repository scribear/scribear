import Type from 'typebox';

import { ClientMessageTypes } from './client-message-types.js';

const AuthMessageSchema = Type.Object({
  type: Type.Literal(ClientMessageTypes.AUTH),
  api_key: Type.String(),
});
export { AuthMessageSchema };

export type AuthMessage = Type.Static<typeof AuthMessageSchema>;
