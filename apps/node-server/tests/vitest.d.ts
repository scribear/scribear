import type { TranscriptionServiceManagerConfig } from '#src/server/features/session-streaming/transcription-service-manager.js';

declare module 'vitest' {
  export interface ProvidedContext {
    transcriptionServiceManagerConfig: TranscriptionServiceManagerConfig;
  }
}
