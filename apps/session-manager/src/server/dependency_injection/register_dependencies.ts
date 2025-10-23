// Need to import so that declare module '@fastify/awilix' below works
import '@fastify/awilix';
import { type AwilixContainer, Lifetime, asClass, asValue } from 'awilix';

import type { BaseDependencies } from '@scribear/base-fastify-server';

import type AppConfig from '../../app_config/app_config.js';
import CalculatorController from '../features/calculator/calculator.controller.js';
import CalculatorService from '../features/calculator/calculator.service.js';
import HealthcheckController from '../features/healthcheck/healthcheck.controller.js';

/**
 * Define types for entities in dependency container
 */
interface AppDependencies extends BaseDependencies {
  config: AppConfig;

  // Healthcheck
  healthcheckController: HealthcheckController;

  // Calculator
  calculatorController: CalculatorController;
  calculatorService: CalculatorService;
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

    // Healthcheck
    healthcheckController: asClass(HealthcheckController, {
      lifetime: Lifetime.SCOPED,
    }),

    // Calculator
    calculatorController: asClass(CalculatorController, {
      lifetime: Lifetime.SCOPED,
    }),
    calculatorService: asClass(CalculatorService, {
      lifetime: Lifetime.SCOPED,
    }),
  });
}

export default registerDependencies;
export type { AppDependencies };
