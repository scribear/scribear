import { Type } from 'typebox';

import type {
  BaseRouteDefinition,
  BaseWebSocketRouteSchema,
} from '@scribear/base-schema';

import { NODE_SERVER_BASE_PATH } from '#src/base-path.js';
import { TRANSCRIPTION_STREAM_TAG } from '#src/tags.js';
import { TRANSCRIPT_FRAGMENT_SCHEMA } from '#src/transcription-stream/entities/transcript.schema.js';

export enum TranscriptionStreamClientMessageType {
  AUTH = 'auth',
  TIME_SYNC_PING = 'timeSyncPing',
  SOURCE_STATE = 'sourceState',
}

export enum TranscriptionStreamServerMessageType {
  AUTH_OK = 'authOk',
  TRANSCRIPT = 'transcript',
  SESSION_STATUS = 'sessionStatus',
  SESSION_ENDED = 'sessionEnded',
  TIME_SYNC_PONG = 'timeSyncPong',
  LATENCY_UPDATE = 'latencyUpdate',
}

/**
 * Which transcript a latency sample describes. `final` samples measure a
 * finalized transcript; `inProgress` samples measure an interim one.
 */
export enum LatencyKind {
  FINAL = 'final',
  IN_PROGRESS = 'inProgress',
}

const TRANSCRIPTION_STREAM_SCHEMA = {
  description:
    "Bidirectional WebSocket for a session's transcription stream. The session UID is carried in the URL so the L7 proxy can sticky-route every connection for a session to the same Node Server instance, where the orchestrator state for that session lives. After the socket opens, the client must send a single `auth` message carrying its session token; the server replies `authOk` once the token is verified against the URL's session UID, or closes 1008 on failure. Source-scoped clients then send raw audio as binary frames; clients with the receive-transcripts scope receive `transcript` messages as the upstream provider emits them. The server sends `sessionEnded` and closes 1000 when the session reaches its scheduled end.",
  tags: [TRANSCRIPTION_STREAM_TAG],
  params: Type.Object({
    sessionUid: Type.String({ format: 'uuid' }),
  }),
  allowClientBinaryMessage: true,
  clientMessage: Type.Union([
    Type.Object({
      type: Type.Literal(TranscriptionStreamClientMessageType.AUTH),
      sessionToken: Type.String({ maxLength: 4096 }),
    }),
    // Clock-sync probe (Cristian's algorithm). The source sends its send
    // time `t0`; the server echoes it with its own receive time `t1` so the
    // source can estimate the server-vs-client clock offset and correct the
    // `sentAt` it stamps on audio frames. See `timeSyncPong`.
    Type.Object({
      type: Type.Literal(TranscriptionStreamClientMessageType.TIME_SYNC_PING),
      t0: Type.Number(),
    }),
    // Source reports its microphone state so the fleet dashboard can
    // distinguish "mic is off" from "something broke" when no audio frames
    // arrive. Sent on mute/unmute transitions and once after AUTH_OK to seed.
    Type.Object({
      type: Type.Literal(TranscriptionStreamClientMessageType.SOURCE_STATE),
      microphoneActive: Type.Boolean(),
    }),
  ]),
  allowServerBinaryMessage: false,
  serverMessage: Type.Union([
    Type.Object({
      type: Type.Literal(TranscriptionStreamServerMessageType.AUTH_OK),
    }),
    Type.Object({
      type: Type.Literal(TranscriptionStreamServerMessageType.TRANSCRIPT),
      final: Type.Union([TRANSCRIPT_FRAGMENT_SCHEMA, Type.Null()]),
      inProgress: Type.Union([TRANSCRIPT_FRAGMENT_SCHEMA, Type.Null()]),
    }),
    Type.Object({
      type: Type.Literal(TranscriptionStreamServerMessageType.SESSION_STATUS),
      transcriptionServiceConnected: Type.Boolean({
        description:
          'Whether the Node Server currently has an active connection to the Transcription Service for this session.',
      }),
      sourceDeviceConnected: Type.Boolean({
        description:
          'Whether at least one source device is currently authenticated and streaming audio for this session.',
      }),
      sourceMicrophoneActive: Type.Optional(
        Type.Union([Type.Boolean(), Type.Null()], {
          description:
            'Whether at least one connected source has its microphone active (unmuted). Null when no source has reported state yet. Absent when no source has reported and the publisher predates the field.',
        }),
      ),
    }),
    Type.Object({
      type: Type.Literal(TranscriptionStreamServerMessageType.SESSION_ENDED),
    }),
    // Reply to a `timeSyncPing`: `t0` echoed from the ping, `t1` the server's
    // clock when it handled the ping.
    Type.Object({
      type: Type.Literal(TranscriptionStreamServerMessageType.TIME_SYNC_PONG),
      t0: Type.Number(),
      t1: Type.Number(),
    }),
    // End-to-end latency sample for one transcript. `pipelineMs` is measured
    // entirely on the node's monotonic clock (audio ingress -> transcript)
    // and is therefore skew-free. `e2eMs` additionally includes the capture
    // and uplink legs using the source's clock corrected via time-sync; it is
    // null when no reliable clock offset is available.
    Type.Object({
      type: Type.Literal(TranscriptionStreamServerMessageType.LATENCY_UPDATE),
      kind: Type.Enum(LatencyKind),
      pipelineMs: Type.Number(),
      e2eMs: Type.Union([Type.Number(), Type.Null()]),
    }),
  ]),
  closeCodes: {
    1000: { description: 'Normal closure.' },
    1001: { description: 'Going away (server shutdown).' },
    1006: { description: 'Abnormal closure.' },
    1007: {
      description:
        'Invalid client message - JSON parse failure or schema mismatch.',
    },
    1008: {
      description:
        'Authentication failure: missing/expired/revoked token, missing required scope, or auth not received within the handshake timeout.',
    },
    1011: { description: 'Internal server error.' },
    1012: { description: 'Service restart.' },
  },
} satisfies BaseWebSocketRouteSchema;

const TRANSCRIPTION_STREAM_SOURCE_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  websocket: true,
  url: `${NODE_SERVER_BASE_PATH}/transcription-stream/:sessionUid/source`,
};

const TRANSCRIPTION_STREAM_CLIENT_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  websocket: true,
  url: `${NODE_SERVER_BASE_PATH}/transcription-stream/:sessionUid/client`,
};

export {
  TRANSCRIPTION_STREAM_SCHEMA,
  TRANSCRIPTION_STREAM_SOURCE_ROUTE,
  TRANSCRIPTION_STREAM_CLIENT_ROUTE,
};
