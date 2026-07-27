import { createWebSocketClient } from '@scribear/base-websocket-client';
import type { WebSocketClient } from '@scribear/base-websocket-client';
import {
  TRANSCRIPTION_STREAM_SCHEMA,
  type TRANSCRIPTION_STREAM_SOURCE_ROUTE,
  TranscriptionStreamClientMessageType,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';

/**
 * Opening an authenticated transcription-stream socket, shared by every
 * synthetic source device.
 *
 * The handshake here — send `auth`, wait for `authOk`, only then treat the
 * socket as open — is protocol rather than convenience, and getting it wrong is
 * silent: a socket that skips it stays connected and simply has every frame
 * ignored. Having exactly one implementation is what keeps the canary and the
 * test-audio devices from drifting into two subtly different clients, only one
 * of which resembles a real source.
 */

/** A client speaking the transcription-stream protocol. */
export type StreamSocket = WebSocketClient<typeof TRANSCRIPTION_STREAM_SCHEMA>;

/**
 * Close codes the client must not retry.
 *
 * 1008 means the token was rejected. The default behaviour — reconnect with
 * backoff — would hammer session-manager with doomed handshakes for the whole
 * run window and bury the real signal. Listing it as a "normal" close makes the
 * client stop, so the run fails fast with an accurate reason.
 */
const NORMAL_CLOSE_CODES = [1000, 1001, 1008];

/**
 * Connects to `route` for `sessionUid` and authenticates in the handshake.
 *
 * The returned socket is already started but not yet open; pair this with
 * {@link waitForSocketOpen} before sending anything.
 */
export function connectStreamSocket(
  nodeServerBaseUrl: string,
  route: typeof TRANSCRIPTION_STREAM_SOURCE_ROUTE,
  sessionUid: string,
  sessionToken: string,
): StreamSocket {
  const factory = createWebSocketClient(
    TRANSCRIPTION_STREAM_SCHEMA,
    route,
    nodeServerBaseUrl,
    {
      normalCloseCodes: NORMAL_CLOSE_CODES,
      // Rejecting here abandons the attempt, so a bad token surfaces as a
      // failed run rather than a silently useless socket.
      onHandshake: async (sender, messages) => {
        sender.send({
          type: TranscriptionStreamClientMessageType.AUTH,
          sessionToken,
        });
        await new Promise<void>((resolve) => {
          const onMessage = (msg: {
            type: TranscriptionStreamServerMessageType;
          }) => {
            if (msg.type === TranscriptionStreamServerMessageType.AUTH_OK) {
              messages.off('message', onMessage);
              resolve();
            }
          };
          messages.on('message', onMessage);
        });
      },
    },
  );
  const socket = factory({ params: { sessionUid } });
  socket.start();
  return socket;
}

/** Resolves when the socket reaches an authenticated OPEN, or rejects. */
export function waitForSocketOpen(
  socket: StreamSocket,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Socket did not open within ${String(timeoutMs)}ms.`));
    }, timeoutMs);

    const onOpen = () => {
      cleanup();
      resolve();
    };
    // A close with no scheduled reconnect means the client has given up — for
    // 1008 that is an auth rejection, and waiting out the timeout would report
    // a vague "did not open" instead of the actual cause.
    const onClose = (
      code: number,
      reason: string,
      reconnectInMs: number | null,
    ) => {
      if (reconnectInMs !== null) return;
      cleanup();
      reject(
        new Error(
          `Socket closed before opening: ${String(code)} ${reason || '(no reason)'}.`,
        ),
      );
    };

    function cleanup() {
      clearTimeout(timer);
      socket.off('open', onOpen);
      socket.off('close', onClose);
    }

    socket.on('open', onOpen);
    socket.on('close', onClose);
  });
}
