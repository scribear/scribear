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

import type AppConfig from '#src/app-config/app-config.js';
import DBClient, { type DBClientConfig } from '#src/db/db-client.js';

import { HealthcheckController } from '../features/healthcheck/healthcheck.controller.js';
import { KioskManagementController } from '../features/kiosk-management/kiosk-management.controller.js';
import { KioskManagementRepository } from '../features/kiosk-management/kiosk-management.repository.js';
import { KioskManagementService } from '../features/kiosk-management/kiosk-management.service.js';
import { SessionController } from '../features/session/session.controller.js';
import { SessionService } from '../features/session/session.service.js';
import { AuthRepository } from '../shared/auth/auth.repository.js';
import {
  AuthService,
  type AuthServiceConfig,
} from '../shared/auth/auth.service.js';
import { HashService, type HashServiceConfig } from '../shared/hash.service.js';
import { JwtService, type JwtServiceConfig } from '../shared/jwt.service.js';

/**
 * Define types for entities in dependency container
 */
export interface AppDependencies extends BaseDependencies {
  // Database
  dbClientConfig: DBClientConfig;
  dbClient: DBClient;

  // Services
  jwtServiceConfig: JwtServiceConfig;
  jwtService: JwtService;

  hashServiceConfig: HashServiceConfig;
  hashService: HashService;

  authServiceConfig: AuthServiceConfig;
  authService: AuthService;
  authRepository: AuthRepository;

  // Healthcheck
  healthcheckController: HealthcheckController;

  // Session
  sessionController: SessionController;
  sessionService: SessionService;

  // Kiosk Management
  kioskManagementController: KioskManagementController;
  kioskManagementService: KioskManagementService;
  kioskManagementRepository: KioskManagementRepository;
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
export function registerDependencies(
  dependencyContainer: AwilixContainer,
  config: AppConfig,
) {
  dependencyContainer.register({
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

    hashServiceConfig: asValue(config.hashServiceConfig),
    hashService: asClass(HashService, {
      lifetime: Lifetime.SCOPED,
    }),

    authServiceConfig: asValue(config.authServiceConfig),
    authService: asClass(AuthService, {
      lifetime: Lifetime.SCOPED,
    }),
    authRepository: asClass(AuthRepository, {
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

    // Kiosk Management
    kioskManagementController: asClass(KioskManagementController, {
      lifetime: Lifetime.SCOPED,
    }),
    kioskManagementService: asClass(KioskManagementService, {
      lifetime: Lifetime.SCOPED,
    }),
    kioskManagementRepository: asClass(KioskManagementRepository, {
      lifetime: Lifetime.SCOPED,
    }),
  } as NameAndRegistrationPair<AppDependencies>);
}
