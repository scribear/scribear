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

import type { AppConfig, BaseConfig } from '#src/app-config/app-config.js';
import { DBClient, type DBClientConfig } from '#src/db/db-client.js';

import { HealthcheckController } from '../features/healthcheck/healthcheck.controller.js';

/**
 * Define types for entities in dependency container
 */
interface AppDependencies extends BaseDependencies {
  // Base Config
  baseConfig: BaseConfig;

  // Database
  dbClientConfig: DBClientConfig;
  dbClient: DBClient;

  // Healthcheck
  healthcheckController: HealthcheckController;
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
    // Base Config
    baseConfig: asValue(config.baseConfig),

    // Database
    dbClientConfig: asValue(config.dbClientConfig),
    dbClient: asClass(DBClient, {
      lifetime: Lifetime.SINGLETON,
    }),

    // Healthcheck
    healthcheckController: asClass(HealthcheckController, {
      lifetime: Lifetime.SCOPED,
    }),
  } as NameAndRegistrationPair<AppDependencies>);
}

export default registerDependencies;
export type { AppDependencies };
