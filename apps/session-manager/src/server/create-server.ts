import fastifyCookie from '@fastify/cookie';

import { createBaseServer } from '@scribear/base-fastify-server';

import type { AppConfig } from '#src/app-config/app-config.js';

import type { AppDependencies } from './dependency-injection/app-dependencies.js';
import registerDependencies from './dependency-injection/register-dependencies.js';
import { deviceManagementRouter } from './features/device-management/device-management.router.js';
import { probesRouter } from './features/probes/probes.router.js';
import { roomManagementRouter } from './features/room-management/room-management.router.js';
import { scheduleManagementRouter } from './features/schedule-management/schedule-management.router.js';
import swagger from './plugins/swagger.js';

/**
 * Initializes the Fastify server, registers plugins, dependencies, and routes.
 */
async function createServer(config: AppConfig) {
  const { logger, dependencyContainer, fastify } = createBaseServer(
    config.baseConfig.logLevel,
  );

  if (config.baseConfig.isDevelopment) {
    await fastify.register(swagger);
  }
  fastify.register(fastifyCookie);

  registerDependencies(dependencyContainer, config);

  fastify.register(probesRouter);
  fastify.register(deviceManagementRouter);
  fastify.register(roomManagementRouter);
  fastify.register(scheduleManagementRouter);

  const materializationWorker = dependencyContainer.resolve<
    AppDependencies['materializationWorker']
  >('materializationWorker');
  fastify.addHook('onReady', () => {
    materializationWorker.start();
  });
  fastify.addHook('onClose', async () => {
    await materializationWorker.stop();
  });

  return { logger, fastify };
}

export default createServer;
