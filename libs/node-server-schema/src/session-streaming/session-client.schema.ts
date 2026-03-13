import { Type } from 'typebox';

import { type BaseRouteDefinition } from '@scribear/base-schema';
import type { BaseWebSocketRouteSchema } from '@scribear/base-schema/src/types/base-websocket-route-schema.js';

import { SESSION_STREAMING_TAG } from '../tags.js';

export enum SessionClientClientMessageType {
  AUTH = 'AUTH',
}

export enum SessionClientServerMessageType {
  IP_TRANSCRIPT = 'IP_TRANSCRIPT',
  FINAL_TRANSCRIPT = 'FINAL_TRANSCRIPT',
}

const SESSION_CLIENT_SCHEMA = {
  description: 'Accepts a connection from an session client to a session',
  tags: [SESSION_STREAMING_TAG],
  params: Type.Object({
    sessionId: Type.String({ maxLength: 36 }),
  }),
  allowClientBinaryMessage: false,
  clientMessage: Type.Union([
    Type.Object({
      type: Type.Literal(SessionClientClientMessageType.AUTH),
      sessionToken: Type.String({ maxLength: 1024 }),
    }),
  ]),
  allowServerBinaryMessage: false,
  serverMessage: Type.Union([
    Type.Object({
      type: Type.Literal(SessionClientServerMessageType.IP_TRANSCRIPT),
      text: Type.Array(Type.String()),
      starts: Type.Union([Type.Array(Type.Number()), Type.Null()]),
      ends: Type.Union([Type.Array(Type.Number()), Type.Null()]),
    }),
    Type.Object({
      type: Type.Literal(SessionClientServerMessageType.FINAL_TRANSCRIPT),
      text: Type.Array(Type.String()),
      starts: Type.Union([Type.Array(Type.Number()), Type.Null()]),
      ends: Type.Union([Type.Array(Type.Number()), Type.Null()]),
    }),
  ]),
  closeCodes: {
    1000: { description: 'Normal closure' },
    1001: { description: 'Normal closure, going away' },
    1006: { description: 'Abnormal closure' },
    1007: {
      description: 'Invalid message format or configuration format received',
    },
    1008: { description: 'Authentication failure or timeout' },
    1011: { description: 'Internal server error' },
  },
} satisfies BaseWebSocketRouteSchema;

const SESSION_CLIENT_ROUTE: BaseRouteDefinition = {
  method: 'GET',
  websocket: true,
  url: '/api/node-server/session-streaming/v1/session-client/:sessionId',
};

export { SESSION_CLIENT_SCHEMA, SESSION_CLIENT_ROUTE };
