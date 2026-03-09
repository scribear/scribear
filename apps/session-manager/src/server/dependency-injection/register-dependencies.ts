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

import { DeviceManagementController } from '../features/device-management/device-management.controller.js';
import { DeviceManagementRepository } from '../features/device-management/device-management.repository.js';
import { DeviceManagementService } from '../features/device-management/device-management.service.js';
import { HealthcheckController } from '../features/healthcheck/healthcheck.controller.js';
import { SessionEventBusService } from '../features/session-management/session-event-bus.service.js';
import { SessionManagementController } from '../features/session-management/session-management.controller.js';
import { SessionManagementRepository } from '../features/session-management/session-management.repository.js';
import { SessionManagementService } from '../features/session-management/session-management.service.js';
import { AuthRepository } from '../repositories/auth.repository.js';
import {
  AuthService,
  type AuthServiceConfig,
} from '../services/auth.service.js';
import { HashService } from '../services/hash.service.js';
import { JwtService } from '../features/session-management/jwt.service.js';

/**
 * Define types for entities in dependency container
 */
interface AppDependencies extends BaseDependencies {
  // Base Config
  baseConfig: BaseConfig;

  // Database
  dbClientConfig: DBClientConfig;
  dbClient: DBClient;

  // Auth
  authServiceConfig: AuthServiceConfig;
  authService: AuthService;
  authRepository: AuthRepository;

  // JWT
  jwtServiceConfig: { jwtSecret: string };
  jwtService: JwtService;

  // Hash
  hashService: HashService;

  // Healthcheck
  healthcheckController: HealthcheckController;

  // Device Management
  deviceManagementController: DeviceManagementController;
  deviceManagementService: DeviceManagementService;
  deviceManagementRepository: DeviceManagementRepository;

  // Session Management
  sessionEventBusService: SessionEventBusService;
  sessionManagementController: SessionManagementController;
  sessionManagementService: SessionManagementService;
  sessionManagementRepository: SessionManagementRepository;
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

    // Auth
    authServiceConfig: asValue(config.authServiceConfig),
    authService: asClass(AuthService, { lifetime: Lifetime.SCOPED }),
    authRepository: asClass(AuthRepository, { lifetime: Lifetime.SINGLETON }),

    // JWT
    jwtServiceConfig: asValue(config.jwtServiceConfig),
    jwtService: asClass(JwtService, { lifetime: Lifetime.SINGLETON }),

    // Hash
    hashService: asClass(HashService, { lifetime: Lifetime.SINGLETON }),

    // Healthcheck
    healthcheckController: asClass(HealthcheckController, {
      lifetime: Lifetime.SCOPED,
    }),

    // Device Management
    deviceManagementController: asClass(DeviceManagementController, {
      lifetime: Lifetime.SCOPED,
    }),
    deviceManagementService: asClass(DeviceManagementService, {
      lifetime: Lifetime.SCOPED,
    }),
    deviceManagementRepository: asClass(DeviceManagementRepository, {
      lifetime: Lifetime.SINGLETON,
    }),

    // Session Management
    sessionEventBusService: asClass(SessionEventBusService, {
      lifetime: Lifetime.SINGLETON,
    }),
    sessionManagementController: asClass(SessionManagementController, {
      lifetime: Lifetime.SCOPED,
    }),
    sessionManagementService: asClass(SessionManagementService, {
      lifetime: Lifetime.SCOPED,
    }),
    sessionManagementRepository: asClass(SessionManagementRepository, {
      lifetime: Lifetime.SINGLETON,
    }),
  } as NameAndRegistrationPair<AppDependencies>);
}

export default registerDependencies;
export type { AppDependencies };
