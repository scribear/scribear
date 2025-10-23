import { fastifyAwilixPlugin } from '@fastify/awilix';
import fastifyHelmet from '@fastify/helmet';
import { fastifySensible } from '@fastify/sensible';
import {
  type AwilixContainer,
  InjectionMode,
  asValue,
  createContainer,
} from 'awilix';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { v4 as uuidv4 } from 'uuid';

import type { BaseLogger, LogLevel } from './create_logger.js';
import { createLogger } from './create_logger.js';
import scopeLogger from './hooks/on_request/scope_logger.js';
import errorHandler from './plugins/error_handler.js';
import jsonParser from './plugins/json_parser.js';
import notFoundHandler from './plugins/not_found_handler.js';
import schemaValidator from './plugins/schema_validator.js';
import type { BaseDependencies } from './types/base_dependencies.js';
import type { BaseFastifyInstance } from './types/base_fastify_types.js';

/**
 * Creates fastify server, logger, dependency container and loads default plugins and hooks
 * @param logLevel Minimum log severity level for created logger
 * @param fastifyConfig Additional options for fastify server
 * @returns object containing fastify server, logger, and dependency container
 */
function createBaseServer(
  logLevel: LogLevel,
  fastifyConfig?: FastifyServerOptions,
): {
  logger: BaseLogger;
  dependencyContainer: AwilixContainer<BaseDependencies>;
  fastify: BaseFastifyInstance;
} {
  const logger = createLogger(logLevel);

  const dependencyContainer: AwilixContainer<BaseDependencies> =
    createContainer({
      injectionMode: InjectionMode.CLASSIC,
      strict: true,
    });
  dependencyContainer.register({ logger: asValue(logger) });

  const fastify = Fastify({
    loggerInstance: logger,
    ...fastifyConfig,
  });

  fastify.register(fastifyAwilixPlugin, {
    container: dependencyContainer,
    disposeOnClose: true,
    disposeOnResponse: true,
    strictBooleanEnforced: true,
  });

  // Use UUIDv4 for request ids
  fastify.setGenReqId(() => uuidv4());

  // Register plugins
  fastify.register(fastifySensible);
  fastify.register(fastifyHelmet);
  fastify.register(errorHandler);
  fastify.register(jsonParser);
  fastify.register(notFoundHandler);
  fastify.register(schemaValidator);

  // Register hooks
  fastify.register(scopeLogger);

  return {
    logger,
    dependencyContainer,
    fastify: fastify as BaseFastifyInstance,
  };
}

export default createBaseServer;
