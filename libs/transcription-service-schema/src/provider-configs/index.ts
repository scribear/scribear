import Type from 'typebox';

import { DebugProviderConfigSchema } from './debug-provider-config.js';
import { WhisperStreamingProviderConfigSchema } from './whisper-streaming-provider-config.js';

export * from './debug-provider-config.js';
export * from './whisper-streaming-provider-config.js';

const TranscriptionProviderConfigSchema = Type.Union([
  DebugProviderConfigSchema,
  WhisperStreamingProviderConfigSchema,
]);
export { TranscriptionProviderConfigSchema };

export type TranscriptionProviderConfig = Type.Static<
  typeof TranscriptionProviderConfigSchema
>;
