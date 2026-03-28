import { createEndpointClient } from '@scribear/base-api-client';
import { createWebSocketClient } from '@scribear/base-websocket-client';
import {
  AUDIO_SOURCE_ROUTE,
  AUDIO_SOURCE_SCHEMA,
  HEALTHCHECK_ROUTE,
  HEALTHCHECK_SCHEMA,
  SESSION_CLIENT_ROUTE,
  SESSION_CLIENT_SCHEMA,
} from '@scribear/node-server-schema';

/**
 * Creates a typed WebSocket client for node server.
 *
 * @param baseUrl - Base URL of the node server (e.g. "http://localhost:4000").
 * @returns An object containing a typed connect function for the transcription stream.
 */
function createNodeServerClient(baseUrl: string) {
  return {
    healthcheck: createEndpointClient(
      HEALTHCHECK_SCHEMA,
      HEALTHCHECK_ROUTE,
      baseUrl,
    ),
    audioSource: createWebSocketClient(
      AUDIO_SOURCE_SCHEMA,
      AUDIO_SOURCE_ROUTE,
      baseUrl,
    ),
    sessionClient: createWebSocketClient(
      SESSION_CLIENT_SCHEMA,
      SESSION_CLIENT_ROUTE,
      baseUrl,
    ),
  };
}

export { createNodeServerClient };
