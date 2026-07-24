import crypto from 'node:crypto';
import { describe, expect, inject } from 'vitest';
import type WebSocket from 'ws';

import {
  TranscriptionStreamClientMessageType,
  TranscriptionStreamServerMessageType,
} from '@scribear/node-server-schema';
import type { SessionTokenPayload } from '@scribear/session-manager-schema';

import { DEFAULT_DEMO_SESSION_UID } from '#src/server/features/demo-room/demo-room.constants.js';
import { useServer } from '#tests/utils/use-server.js';

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 3600;

interface ServerMessage {
  type: TranscriptionStreamServerMessageType;
  [key: string]: unknown;
}

/** HMAC-sign a session token the way the Session Manager does. */
function signToken(payload: SessionTokenPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  const signature = crypto
    .createHmac('sha256', inject('sessionTokenSigningKey'))
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${signature}`;
}

function bufferOf(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

/**
 * Attach one persistent listener that records every JSON server message into a
 * growing array. A single collector (rather than sequential one-shot waiters)
 * is essential here: `sessionStatus` is emitted once, right after `authOk`, so
 * a second listener attached later would miss it.
 */
function collectMessages(ws: WebSocket): ServerMessage[] {
  const messages: ServerMessage[] = [];
  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      messages.push(
        JSON.parse(bufferOf(data).toString('utf8')) as ServerMessage,
      );
    } catch {
      /* ignore non-JSON frames */
    }
  });
  return messages;
}

/** Poll until `predicate` holds over the collected messages, or time out. */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('timed out waiting for the expected server messages');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('Demo caption room', () => {
  // Boot a server with the demo room enabled. It needs no source device and no
  // upstream transcription service - the whole point of the feature.
  const server = useServer({ demoRoomConfig: { enabled: true } });

  const clientPath = `/api/node-server/v1/transcription-stream/${DEFAULT_DEMO_SESSION_UID}/client`;

  function authAsClient(ws: WebSocket): void {
    ws.send(
      JSON.stringify({
        type: TranscriptionStreamClientMessageType.AUTH,
        sessionToken: signToken({
          sessionUid: DEFAULT_DEMO_SESSION_UID,
          clientId: 'demo-client-1',
          scopes: ['RECEIVE_TRANSCRIPTIONS'],
          exp: FAR_FUTURE,
        }),
      }),
    );
  }

  describe('a joining client', (it) => {
    it('authenticates, is told the session is healthy, and receives looping captions', async () => {
      // Arrange
      const ws = await server.fastify.injectWS(clientPath);
      const messages = collectMessages(ws);

      // Act
      authAsClient(ws);

      // Assert - auth acknowledged.
      await waitUntil(() =>
        messages.some(
          (m) => m.type === TranscriptionStreamServerMessageType.AUTH_OK,
        ),
      );

      // Synthetic status: connected even though there is no source or upstream.
      await waitUntil(() =>
        messages.some(
          (m) =>
            m.type === TranscriptionStreamServerMessageType.SESSION_STATUS &&
            m['transcriptionServiceConnected'] === true &&
            m['sourceDeviceConnected'] === true,
        ),
      );

      // A transcript with an interim (partial) fragment, and one with a final.
      await waitUntil(() =>
        messages.some(
          (m) =>
            m.type === TranscriptionStreamServerMessageType.TRANSCRIPT &&
            m['inProgress'] !== null,
        ),
      );
      await waitUntil(() =>
        messages.some(
          (m) =>
            m.type === TranscriptionStreamServerMessageType.TRANSCRIPT &&
            m['final'] !== null,
        ),
      );

      // Fragments are word-token arrays, as the wire schema promises.
      const interimMsg = messages.find(
        (m) =>
          m.type === TranscriptionStreamServerMessageType.TRANSCRIPT &&
          m['inProgress'] !== null,
      );
      const interim = interimMsg?.['inProgress'] as { text: string[] };
      expect(Array.isArray(interim.text)).toBe(true);
      expect(interim.text.length).toBeGreaterThan(0);

      ws.terminate();
    });
  });
});
