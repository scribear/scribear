import cors from '@fastify/cors';
import { createBaseServer } from '@scribear/base-fastify-server';

import type AppConfig from '../app-config/app-config.js';
import registerDependencies from './dependency-injection/register-dependencies.js';
import healthcheckRouter from './features/healthcheck/healthcheck.router.js';
import sessionRouter from './features/session/session.router.js';
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

  // Enable CORS so the webapp (different origin) can call our API
  await fastify.register(cors, { origin: true });

  // Only include swagger docs if in development mode
  if (config.baseConfig.isDevelopment) {
    await fastify.register(swagger);
  }

  registerDependencies(dependencyContainer, config);

  // Register routes
  fastify.register(healthcheckRouter);
  fastify.register(sessionRouter);

  return { logger, fastify };
}

export default createServer;
