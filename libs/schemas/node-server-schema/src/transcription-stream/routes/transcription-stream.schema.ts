import { Type } from 'typebox';

import type {
  BaseRouteDefinition,
  BaseWebSocketRouteSchema,
} from '@scribear/base-schema';

import { NODE_SERVER_BASE_PATH } from '#src/base-path.js';
import { SESSION_TOKEN_SECURITY } from '#src/shared/security/session-token.js';
import { TRANSCRIPTION_STREAM_TAG } from '#src/tags.js';
import { TRANSCRIPT_FRAGMENT_SCHEMA } from '#src/transcription-stream/entities/transcript.schema.js';

export enum TranscriptionStreamClientMessageType {
  AUTH = 'auth',
}

export enum TranscriptionStreamServerMessageType {
  AUTH_OK = 'authOk',
  TRANSCRIPT = 'transcript',
  SESSION_ENDED = 'sessionEnded',
}

const TRANSCRIPTION_STREAM_SCHEMA = {
  description:
    "Bidirectional WebSocket for a session's transcription stream. The session UID is carried in the URL so the L7 proxy can sticky-route every connection for a session to the same Node Server instance, where the orchestrator state for that session lives. After the socket opens, the client must send a single `auth` message carrying its session token; the server replies `authOk` once the token is verified against the URL's session UID, or closes 1008 on failure. Source-scoped clients then send raw audio as binary frames; clients with the receive-transcripts scope receive `transcript` messages as the upstream provider emits them. The server sends `sessionEnded` and closes 1000 when the session reaches its scheduled end.",
  tags: [TRANSCRIPTION_STREAM_TAG],
  security: SESSION_TOKEN_SECURITY,
  params: Type.Object({
    sessionUid: Type.String({ format: 'uuid' }),
  }),
  allowClientBinaryMessage: true,
  clientMessage: Type.Union([
    Type.Object({
      type: Type.Literal(TranscriptionStreamClientMessageType.AUTH),
      sessionToken: Type.String({ maxLength: 4096 }),
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
      type: Type.Literal(TranscriptionStreamServerMessageType.SESSION_ENDED),
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
