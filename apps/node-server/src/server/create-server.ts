import { createBaseServer } from '@scribear/base-fastify-server';

import type { AppConfig } from '#src/app-config/app-config.js';

import registerDependencies from './dependency-injection/register-dependencies.js';
import { probesRouter } from './features/probes/probes.router.js';
import { transcriptionStreamRouter } from './features/transcription-stream/transcription-stream.router.js';
import swagger from './plugins/swagger.js';
import websocket from './plugins/websocket.js';

/**
 * Initializes the Fastify server, registers plugins, dependencies, and routes.
 */
async function createServer(config: AppConfig) {
  const { logger, dependencyContainer, fastify } = createBaseServer(
    config.baseConfig.logLevel,
  );

  await fastify.register(websocket);

  if (config.baseConfig.isDevelopment) {
    await fastify.register(swagger);
  }

  registerDependencies(dependencyContainer, config);

  fastify.register(probesRouter);
  fastify.register(transcriptionStreamRouter);

  return { logger, fastify };
}

export default createServer;
