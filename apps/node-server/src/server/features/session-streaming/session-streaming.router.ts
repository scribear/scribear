import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  AUDIO_SOURCE_ROUTE,
  AUDIO_SOURCE_SCHEMA,
  MUTE_SESSION_ROUTE,
  MUTE_SESSION_SCHEMA,
  SESSION_CLIENT_ROUTE,
  SESSION_CLIENT_SCHEMA,
} from '@scribear/node-server-schema';

import { resolveHandler } from '#src/server/dependency-injection/resolve-handler.js';
import { resolveWsHandler } from '#src/server/dependency-injection/resolve-ws-handler.js';

/**
 * Registers session streaming routes for audio-source and session-client WebSocket connections.
 *
 * @param fastify - The Fastify app instance.
 */
export function sessionStreamingRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...AUDIO_SOURCE_ROUTE,
    schema: AUDIO_SOURCE_SCHEMA,
    handler: resolveWsHandler('sessionStreamingController', 'audioSource'),
  });

  fastify.route({
    ...SESSION_CLIENT_ROUTE,
    schema: SESSION_CLIENT_SCHEMA,
    handler: resolveWsHandler('sessionStreamingController', 'sessionClient'),
  });

  fastify.route({
    ...MUTE_SESSION_ROUTE,
    schema: MUTE_SESSION_SCHEMA,
    handler: resolveHandler('sessionStreamingController', 'muteSession'),
  });
}
