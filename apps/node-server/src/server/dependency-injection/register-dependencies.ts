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
import type { TranscriptionConfig } from '../../app-config/app-config.js';
import HealthcheckController from '../features/healthcheck/healthcheck.controller.js';
import RoomController from '../features/room/room.controller.js';
import { JwtService, type JwtServiceConfig } from '../services/jwt.service.js';
import { RoomManagerService } from '../services/room-manager.service.js';

/**
 * Define types for entities in dependency container
 */
interface AppDependencies extends BaseDependencies {
    // Config
    config: AppConfig;
    jwtServiceConfig: JwtServiceConfig;
    transcriptionConfig: TranscriptionConfig;

    // Services
    jwtService: JwtService;
    roomManagerService: RoomManagerService;

    // Controllers
    healthcheckController: HealthcheckController;
    roomController: RoomController;
}

/**
 * Ensure fastify awilix container is typed correctly
 * @see https://github.com/fastify/fastify-awilix?tab=readme-ov-file#typescript-usage
 */
declare module '@fastify/awilix' {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Cradle extends AppDependencies { }

    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RequestCradle extends AppDependencies { }
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
        jwtServiceConfig: asValue({
            jwtSecret: config.jwtSecret,
            jwtIssuer: config.jwtIssuer,
        }),
        transcriptionConfig: asValue(config.transcriptionConfig),

        // Services
        jwtService: asClass(JwtService, {
            lifetime: Lifetime.SCOPED,
        }),
        roomManagerService: asClass(RoomManagerService, {
            lifetime: Lifetime.SINGLETON,
        }),

        // Controllers
        healthcheckController: asClass(HealthcheckController, {
            lifetime: Lifetime.SCOPED,
        }),
        roomController: asClass(RoomController, {
            lifetime: Lifetime.SCOPED,
        }),
    } as NameAndRegistrationPair<AppDependencies>);
}

export default registerDependencies;
export type { AppDependencies };
