import Type from 'typebox';

import { ClientMessageTypes } from './client-message-types.js';

const ConfigMessageSchema = Type.Object({
  type: Type.Literal(ClientMessageTypes.CONFIG),
  config: Type.Any(),
});
export { ConfigMessageSchema };

export type ConfigMessage = Type.Static<typeof ConfigMessageSchema>;
