import { createBaseServer } from '@scribear/base-fastify-server';

import type { AppConfig } from '#src/app-config/app-config.js';

import type { AppDependencies } from './dependency-injection/app-dependencies.js';
import registerDependencies from './dependency-injection/register-dependencies.js';
import { probesRouter } from './features/probes/probes.router.js';
import { statusRouter } from './features/status/status.router.js';
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
  fastify.register(statusRouter);
  fastify.register(transcriptionStreamRouter);

  // Fleet telemetry publishing (B1.7). Resolved only when configured, because
  // resolving the publisher opens the Redis connection: an instance without a
  // URL should hold no connection and log nothing per beat, not retry against
  // an address it was never given.
  if (config.telemetryPublisherConfig.redisUrl !== '') {
    const publisher = dependencyContainer.resolve<
      AppDependencies['redisTelemetryPublisher']
    >('redisTelemetryPublisher');
    fastify.addHook('onReady', () => {
      // Deliberately not awaited and not permitted to fail boot: a Redis that
      // is down or misconfigured must cost the fleet view its cross-instance
      // picture and cost this server's sessions nothing.
      publisher.start();
    });
    fastify.addHook('onClose', async () => {
      await publisher.stop();
    });
  } else {
    logger.info(
      'fleet telemetry publishing disabled: REDIS_URL is unset. This instance will not appear in the fleet view.',
    );
  }

  return { logger, fastify };
}

export default createServer;
