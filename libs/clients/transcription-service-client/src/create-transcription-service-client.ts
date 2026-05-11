import {
  type WebSocketClientFactory,
  createWebSocketClient,
} from '@scribear/base-websocket-client';
import {
  TRANSCRIPTION_STREAM_ROUTE,
  TRANSCRIPTION_STREAM_SCHEMA,
} from '@scribear/transcription-service-schema';

import { createProbesClient } from './probes-client.js';

interface TranscriptionServiceClient {
  probes: ReturnType<typeof createProbesClient>;
  transcriptionStream: WebSocketClientFactory<
    typeof TRANSCRIPTION_STREAM_SCHEMA
  >;
}

/**
 * Creates a typed client bundle for the transcription service.
 *
 * HTTP routes (e.g. probes) are exposed as fetch functions from
 * `createEndpointClient`. WebSocket routes are exposed as
 * {@link WebSocketClientFactory}s that produce an independent
 * {@link WebSocketClient} instance per call, allowing multiple concurrent
 * connections to the same route without sharing client state.
 *
 * @param baseUrl Base URL of the transcription service. HTTP schemes are
 *   translated to ws/wss when each WebSocket connection is established.
 */
function createTranscriptionServiceClient(
  baseUrl: string,
): TranscriptionServiceClient {
  return {
    probes: createProbesClient(baseUrl),
    transcriptionStream: createWebSocketClient(
      TRANSCRIPTION_STREAM_SCHEMA,
      TRANSCRIPTION_STREAM_ROUTE,
      baseUrl,
    ),
  };
}

export { createTranscriptionServiceClient };
export type { TranscriptionServiceClient };
