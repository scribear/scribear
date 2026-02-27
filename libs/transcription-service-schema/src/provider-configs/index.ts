import type { DebugProviderConfig } from './debug-provider-config.js';
import type { WhisperStreamingProviderConfig } from './whisper-streaming-provider-config.js';

export * from './debug-provider-config.js';
export * from './whisper-streaming-provider-config.js';

export type TranscriptionStreamConfig =
  | DebugProviderConfig
  | WhisperStreamingProviderConfig;
