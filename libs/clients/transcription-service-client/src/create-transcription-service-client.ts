import { createWebSocketClient } from '@scribear/base-websocket-client';
import {
  TRANSCRIPTION_STREAM_ROUTE,
  TRANSCRIPTION_STREAM_SCHEMA,
} from '@scribear/transcription-service-schema';

/**
 * Creates a typed WebSocket client for the transcription service.
 *
 * @param baseUrl - Base URL of the transcription service (e.g. "http://localhost:8000").
 * @returns An object containing a typed connect function for the transcription stream.
 */
function createTranscriptionServiceClient(baseUrl: string) {
  return {
    transcriptionStream: createWebSocketClient(
      TRANSCRIPTION_STREAM_SCHEMA,
      TRANSCRIPTION_STREAM_ROUTE,
      baseUrl,
    ),
  };
}

export { createTranscriptionServiceClient };
