import { Type } from 'typebox';

import {
  type BaseRouteDefinition,
  type BaseWebSocketRouteSchema,
} from '@scribear/base-schema';

import { TranscriptionProviderConfigSchema } from '#src/provider-configs/index.js';

export enum TranscriptionStreamClientMessageType {
  AUTH = 'auth',
  CONFIG = 'config',
}

export enum TranscriptionStreamServerMessageType {
  TRANSCRIPT = 'transcript',
}

const TRANSCRIPTION_STREAM_SCHEMA = {
  description: 'Accepts a connection from an client to a session',
  tags: [],
  params: Type.Object({
    providerKey: Type.String({ maxLength: 32 }),
  }),
  allowClientBinaryMessage: true,
  clientMessage: Type.Union([
    Type.Object({
      type: Type.Literal(TranscriptionStreamClientMessageType.AUTH),
      api_key: Type.String({ maxLength: 1024 }),
    }),
    Type.Object({
      type: Type.Literal(TranscriptionStreamClientMessageType.CONFIG),
      config: TranscriptionProviderConfigSchema,
    }),
  ]),
  allowServerBinaryMessage: false,
  serverMessage: Type.Object({
    type: Type.Literal(TranscriptionStreamServerMessageType.TRANSCRIPT),
    final: Type.Union([
      Type.Object({
        text: Type.Array(Type.String()),
        starts: Type.Union([Type.Array(Type.Number()), Type.Null()]),
        ends: Type.Union([Type.Array(Type.Number()), Type.Null()]),
      }),
      Type.Null(),
    ]),
    in_progress: Type.Union([
      Type.Object({
        text: Type.Array(Type.String()),
        starts: Type.Union([Type.Array(Type.Number()), Type.Null()]),
        ends: Type.Union([Type.Array(Type.Number()), Type.Null()]),
      }),
      Type.Null(),
    ]),
  }),
  closeCodes: {
    1000: { description: 'Normal closure' },
    1001: { description: 'Normal closure, going away' },
    1006: { description: 'Abnormal closure' },
    1007: {
      description: 'Invalid message format or configuration format received',
    },
    1008: { description: 'Authentication failure or timeout' },
    1011: { description: 'Internal server error' },
    1012: { description: 'Service Restart' },
  },
} satisfies BaseWebSocketRouteSchema;

const TRANSCRIPTION_STREAM_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  websocket: true,
  url: '/transcription_stream/:providerKey',
};

export { TRANSCRIPTION_STREAM_SCHEMA, TRANSCRIPTION_STREAM_ROUTE };
