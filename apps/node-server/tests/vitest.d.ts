import type { TranscriptionServiceConfig } from '#src/server/features/session-streaming/transcription.service.js';

declare module 'vitest' {
  export interface ProvidedContext {
    transcriptionServiceConfig: TranscriptionServiceConfig;
  }
}
