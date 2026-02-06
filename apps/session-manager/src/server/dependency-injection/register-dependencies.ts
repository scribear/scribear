// Need to import so that declare module '@fastify/awilix' below works
import '@fastify/awilix';
import {
  type AwilixContainer,
  Lifetime,
  type NameAndRegistrationPair,
  asClass,
  asValue,
} from 'awilix';

import type { BaseDependencies } from '@scribear/base-fastify-server';

import type AppConfig from '../../app-config/app-config.js';
import DBClient, { type DBClientConfig } from '../../db/db-client.js';
import HealthcheckController from '../features/healthcheck/healthcheck.controller.js';
import SessionController from '../features/session/session.controller.js';
import { SessionService } from '../features/session/session.service.js';
import { JwtService, type JwtServiceConfig } from '../services/jwt.service.js';

/**
 * Define types for entities in dependency container
 */
interface AppDependencies extends BaseDependencies {
  // Database
  dbClientConfig: DBClientConfig;
  dbClient: DBClient;

  // Services
  jwtServiceConfig: JwtServiceConfig;
  jwtService: JwtService;


  // Healthcheck
  healthcheckController: HealthcheckController;

  // Session
  sessionController: SessionController;
  sessionService: SessionService;
}

/**
 * Ensure fastify awilix container is typed correctly
 * @see https://github.com/fastify/fastify-awilix?tab=readme-ov-file#typescript-usage
 */
declare module '@fastify/awilix' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Cradle extends AppDependencies {}

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface RequestCradle extends AppDependencies {}
}

/**
 * Register all controller, service, and repository classes into dependency container
 * @param dependencyContainer Container to load dependencies into
 * @param config AppConfig to be registered into dependency controller
 */
function registerDependencies(
  dependencyContainer: AwilixContainer,
  config: AppConfig,
) {
  dependencyContainer.register({
    // Config
    config: asValue(config),

    // Database
    dbClientConfig: asValue(config.dbClientConfig),
    dbClient: asClass(DBClient, {
      lifetime: Lifetime.SINGLETON,
    }),

    // Services
    jwtServiceConfig: asValue(config.jwtServiceConfig),
    jwtService: asClass(JwtService, {
      lifetime: Lifetime.SCOPED,
    }),

    // Healthcheck
    healthcheckController: asClass(HealthcheckController, {
      lifetime: Lifetime.SCOPED,
    }),

    // Session
    sessionController: asClass(SessionController, {
      lifetime: Lifetime.SCOPED,
    }),
    sessionService: asClass(SessionService, {
      lifetime: Lifetime.SINGLETON,
    }),
  } as NameAndRegistrationPair<AppDependencies>);
}

export default registerDependencies;
export type { AppDependencies };
