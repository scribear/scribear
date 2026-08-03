import {
  type WebSocketClientFactory,
  createWebSocketClient,
} from '@scribear/base-websocket-client';
import {
  TRANSCRIPTION_STREAM_CLIENT_ROUTE,
  TRANSCRIPTION_STREAM_SCHEMA,
  TRANSCRIPTION_STREAM_SOURCE_ROUTE,
} from '@scribear/node-server-schema';

interface NodeServerClient {
  /**
   * Source-scoped transcription stream. The connecting client must hold a
   * session token granting `SEND_AUDIO`; binary frames are forwarded to the
   * upstream provider and `transcript` messages are received in return.
   */
  transcriptionStreamSource: WebSocketClientFactory<
    typeof TRANSCRIPTION_STREAM_SCHEMA
  >;
  /**
   * Receive-only transcription stream. The connecting client must hold a
   * session token granting `RECEIVE_TRANSCRIPTIONS`; the server emits
   * `transcript` messages but ignores any binary frames the client sends.
   */
  transcriptionStreamClient: WebSocketClientFactory<
    typeof TRANSCRIPTION_STREAM_SCHEMA
  >;
}

/**
 * Creates a typed client bundle for the node server (the session stream
 * server). Each property is a {@link WebSocketClientFactory} bound to one of
 * the two transcription-stream endpoints; calling a factory produces an
 * independent connection so multiple sessions can run in parallel.
 *
 * @param baseUrl Base URL of the node server. HTTP schemes are translated to
 *   ws/wss when each connection is established.
 */
function createNodeServerClient(baseUrl: string): NodeServerClient {
  return {
    transcriptionStreamSource: createWebSocketClient(
      TRANSCRIPTION_STREAM_SCHEMA,
      TRANSCRIPTION_STREAM_SOURCE_ROUTE,
      baseUrl,
      {
        // Everything a source sends is time-critical, so nothing it buffered
        // during an outage is worth delivering afterwards. Capture keeps
        // running while the socket is down - the microphone callback does not
        // know about reconnects - so the send queue fills with audio chunks,
        // and on reconnect the default behaviour flushes the whole backlog
        // onto the fresh socket at once: up to 64 chunks, 6.4 s of audio the
        // room finished saying seconds ago, delivered as if it were current.
        // The text messages on this route are no better aged: a `timeSyncPing`
        // carries the client clock reading from when it was queued, so a stale
        // one poisons the offset it is supposed to measure, and `sourceState`
        // is re-seeded on every `open` anyway.
        //
        // One second is roughly the point past which late captions have
        // already missed the utterance they belong to, while still absorbing
        // a blip shorter than the backoff's initial delay.
        sendQueueMaxAgeMs: 1000,
      },
    ),
    transcriptionStreamClient: createWebSocketClient(
      TRANSCRIPTION_STREAM_SCHEMA,
      TRANSCRIPTION_STREAM_CLIENT_ROUTE,
      baseUrl,
    ),
  };
}

export { createNodeServerClient };
export type { NodeServerClient };
