import type { FastifyReply, FastifyRequest } from 'fastify';

import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  TRANSCRIPTION_STREAM_CLIENT_ROUTE,
  TRANSCRIPTION_STREAM_SCHEMA,
  TRANSCRIPTION_STREAM_SOURCE_ROUTE,
} from '@scribear/node-server-schema';

import resolveWsHandler from '#src/server/dependency-injection/resolve-ws-handler.js';

/**
 * Non-WebSocket clients hitting the transcription-stream URLs get a 426 so
 * misconfigured callers see an actionable response instead of a hung
 * connection.
 */
function upgradeRequiredHandler(_req: FastifyRequest, reply: FastifyReply) {
  reply.code(426).header('Upgrade', 'websocket').send({
    code: 'UPGRADE_REQUIRED',
    message: 'WebSocket upgrade required.',
  });
}

export function transcriptionStreamRouter(fastify: BaseFastifyInstance) {
  // The route definitions carry `websocket: true` so OpenAPI consumers know
  // the endpoints are WebSockets, but @fastify/websocket interprets that
  // flag to mean "treat `handler` as the wsHandler and 404 everything else",
  // which throws away our split between WS upgrade and 426 HTTP fallback.
  // Pass the URL/method explicitly here and rely on `wsHandler` to drive
  // the WS path while `handler` serves non-upgrade requests.
  fastify.route({
    method: TRANSCRIPTION_STREAM_SOURCE_ROUTE.method,
    url: TRANSCRIPTION_STREAM_SOURCE_ROUTE.url,
    schema: TRANSCRIPTION_STREAM_SCHEMA,
    handler: upgradeRequiredHandler,
    wsHandler: resolveWsHandler(
      'transcriptionStreamController',
      'handleSourceConnection',
    ),
  });

  fastify.route({
    method: TRANSCRIPTION_STREAM_CLIENT_ROUTE.method,
    url: TRANSCRIPTION_STREAM_CLIENT_ROUTE.url,
    schema: TRANSCRIPTION_STREAM_SCHEMA,
    handler: upgradeRequiredHandler,
    wsHandler: resolveWsHandler(
      'transcriptionStreamController',
      'handleClientConnection',
    ),
  });
}
