import {
  type WebSocketClientFactory,
  createWebSocketClient,
} from '@scribear/base-websocket-client';
import {
  TRANSCRIPTION_STREAM_ROUTE,
  TRANSCRIPTION_STREAM_SCHEMA,
} from '@scribear/transcription-service-schema';

interface TranscriptionServiceClient {
  transcriptionStream: WebSocketClientFactory<
    typeof TRANSCRIPTION_STREAM_SCHEMA
  >;
}

/**
 * Creates a typed client bundle for the transcription service.
 *
 * Each property on the returned object is a {@link WebSocketClientFactory}
 * bound to a specific route on the service. Calling a factory produces an
 * independent {@link WebSocketClient} instance, allowing multiple concurrent
 * connections to the same route without sharing client state.
 *
 * @param baseUrl Base URL of the transcription service. HTTP schemes are
 *   translated to ws/wss when each connection is established.
 */
function createTranscriptionServiceClient(
  baseUrl: string,
): TranscriptionServiceClient {
  return {
    transcriptionStream: createWebSocketClient(
      TRANSCRIPTION_STREAM_SCHEMA,
      TRANSCRIPTION_STREAM_ROUTE,
      baseUrl,
    ),
  };
}

export { createTranscriptionServiceClient };
export type { TranscriptionServiceClient };
