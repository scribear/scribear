import fastifyCookie from '@fastify/cookie';

import { createBaseServer } from '@scribear/base-fastify-server';

import type { AppConfig } from '../app-config/app-config.js';
import registerDependencies from './dependency-injection/register-dependencies.js';
import { deviceManagementRouter } from './features/device-management/device-management.router.js';
import { healthcheckRouter } from './features/healthcheck/healthcheck.router.js';
import { sessionManagementRouter } from './features/session-management/session-management.router.js';
import swagger from './plugins/swagger.js';

/**
 * Initializes fastify server and registers dependencies
 * @param config Application config
 * @returns Initialized fastify server
 */
async function createServer(config: AppConfig) {
  const { logger, dependencyContainer, fastify } = createBaseServer(
    config.baseConfig.logLevel,
  );

  // Only include swagger docs if in development mode
  if (config.baseConfig.isDevelopment) {
    await fastify.register(swagger);
  }
  fastify.register(fastifyCookie);

  registerDependencies(dependencyContainer, config);

  // Register routes
  fastify.register(healthcheckRouter);
  fastify.register(deviceManagementRouter);
  fastify.register(sessionManagementRouter);

  return { logger, fastify };
}

export default createServer;
