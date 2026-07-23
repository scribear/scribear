import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import { decodeAudioFrame } from '@scribear/audio-frame-protocol';
import {
  LatencyKind,
  TranscriptionStreamServerMessageType as ServerMsg,
} from '@scribear/node-server-schema';

/**
 * A stand-in for node-server and session-manager, speaking the real
 * transcription-stream protocol.
 *
 * The canary's whole value is that it exercises the genuine public flow, so
 * these tests must not mock the canary's own sockets — that would verify only
 * that the test doubles agree with each other. Instead this runs a real HTTP +
 * WebSocket server that implements the protocol as the schema defines it, and
 * the canary connects to it over a real loopback socket, unaware it is a test.
 *
 * Fault injection is done by changing this server's behaviour (refusing auth,
 * withholding transcripts, never reporting an upstream), which is how the real
 * failures present to a client.
 */
export interface FakeNodeServerOptions {
  /** Reject the auth message with 1008, as a bad token would. */
  rejectAuth?: boolean;
  /** Never report `transcriptionServiceConnected: true` (the N1/upstream-down case). */
  upstreamDown?: boolean;
  /**
   * Stop emitting transcripts. The canary should report `no-transcripts` — the
   * headline A2 fault-injection assertion.
   */
  silent?: boolean;
  /** Words emitted per transcript message, cycled in order. */
  script?: string[];
  /** Delay before the first transcript, for latency assertions. */
  firstTranscriptDelayMs?: number;
  /** Interval between transcript messages. */
  transcriptIntervalMs?: number;
  /** Sessions the fake session-manager reports as currently active. */
  activeSessionUid?: string | null;
}

export interface FakeNodeServer {
  /** Base URL for both the node-server and session-manager roles. */
  baseUrl: string;
  /** Audio frames received on source sockets, decoded. */
  receivedChunks: Buffer[];
  /** Number of `/source` and `/client` sockets that completed auth. */
  authenticated: { source: number; client: number };
  close: () => Promise<void>;
}

const AUTH_MESSAGE_TYPE = 'auth';
const TIME_SYNC_PING = 'timeSyncPing';

/** Starts the fake on an ephemeral port. */
export async function startFakeNodeServer(
  options: FakeNodeServerOptions = {},
): Promise<FakeNodeServer> {
  const {
    rejectAuth = false,
    upstreamDown = false,
    silent = false,
    script = ['the', 'birch', 'canoe', 'slid', 'on', 'the', 'smooth', 'planks'],
    firstTranscriptDelayMs = 50,
    transcriptIntervalMs = 50,
    activeSessionUid = '11111111-2222-3333-4444-555555555555',
  } = options;

  const receivedChunks: Buffer[] = [];
  const authenticated = { source: 0, client: 0 };
  const timers = new Set<ReturnType<typeof setInterval>>();

  const http = createServer((req, res) => {
    const url = req.url ?? '';

    // --- fake session-manager -------------------------------------------
    if (
      url.startsWith('/api/session-manager/v1/schedule-management/my-schedule')
    ) {
      if (activeSessionUid === null) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sessions: [] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          roomUid: '99999999-9999-9999-9999-999999999999',
          roomScheduleVersion: 1,
          serverTime: new Date().toISOString(),
          sessions: [
            {
              uid: activeSessionUid,
              effectiveStart: new Date(Date.now() - 60_000).toISOString(),
              effectiveEnd: new Date(Date.now() + 3_600_000).toISOString(),
            },
          ],
        }),
      );
      return;
    }

    if (
      url.startsWith(
        '/api/session-manager/v1/session-auth/exchange-device-token',
      )
    ) {
      if (rejectAuth) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'INVALID_DEVICE_TOKEN' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          sessionToken: 'fake-session-token',
          sessionTokenExpiresAt: new Date(Date.now() + 600_000).toISOString(),
          scopes: ['SEND_AUDIO', 'RECEIVE_TRANSCRIPTIONS'],
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: http });

  wss.on('connection', (socket: WebSocket, req) => {
    const url = req.url ?? '';
    const role: 'source' | 'client' = url.endsWith('/source')
      ? 'source'
      : 'client';
    let authed = false;

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // Decoding here rather than storing raw bytes asserts the canary emits
        // real SAFP: a malformed frame throws and fails the test loudly.
        receivedChunks.push(Buffer.from(decodeAudioFrame(data).audio));
        return;
      }

      const msg = JSON.parse(data.toString()) as {
        type: string;
        t0?: number;
      };

      if (msg.type === TIME_SYNC_PING) {
        socket.send(
          JSON.stringify({
            type: ServerMsg.TIME_SYNC_PONG,
            t0: msg.t0,
            t1: Date.now(),
          }),
        );
        return;
      }

      if (msg.type !== AUTH_MESSAGE_TYPE || authed) return;

      if (rejectAuth) {
        socket.close(1008, 'invalid-token');
        return;
      }

      authed = true;
      authenticated[role]++;
      socket.send(JSON.stringify({ type: ServerMsg.AUTH_OK }));
      socket.send(
        JSON.stringify({
          type: ServerMsg.SESSION_STATUS,
          transcriptionServiceConnected: !upstreamDown,
          sourceDeviceConnected: true,
        }),
      );

      // Only the viewer receives transcripts, mirroring how a real deployment
      // fans out to `/client` subscribers.
      if (role !== 'client' || silent || upstreamDown) return;

      let index = 0;
      setTimeout(() => {
        const timer = setInterval(() => {
          if (socket.readyState !== socket.OPEN) return;
          const word = script[index % script.length];
          index++;
          socket.send(
            JSON.stringify({
              type: ServerMsg.TRANSCRIPT,
              final: { text: [word], starts: null, ends: null },
              inProgress: null,
            }),
          );
          socket.send(
            JSON.stringify({
              type: ServerMsg.LATENCY_UPDATE,
              kind: LatencyKind.FINAL,
              pipelineMs: 120,
              e2eMs: 180,
            }),
          );
        }, transcriptIntervalMs);
        timers.add(timer);
      }, firstTranscriptDelayMs);
    });
  });

  await new Promise<void>((resolve) => {
    http.listen(0, '127.0.0.1', resolve);
  });
  const { port } = http.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    receivedChunks,
    authenticated,
    close: async () => {
      for (const timer of timers) clearInterval(timer);
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
      await closeHttp(http);
    },
  };
}

function closeHttp(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}
