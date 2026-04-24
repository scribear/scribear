import {
  type AwilixContainer,
  Lifetime,
  type NameAndRegistrationPair,
  asClass,
  asValue,
} from 'awilix';

import { DBClient } from '#src/db/db-client.js';
import { DeviceManagementController } from '#src/server/features/device-management/device-management.controller.js';
import { DeviceManagementRepository } from '#src/server/features/device-management/device-management.repository.js';
import { DeviceManagementService } from '#src/server/features/device-management/device-management.service.js';
import { LivenessController } from '#src/server/features/probes/liveness.controller.js';
import { ReadinessController } from '#src/server/features/probes/readiness.controller.js';
import { RoomManagementController } from '#src/server/features/room-management/room-management.controller.js';
import { RoomManagementRepository } from '#src/server/features/room-management/room-management.repository.js';
import { RoomManagementService } from '#src/server/features/room-management/room-management.service.js';
import { DeviceAuthRepository } from '#src/server/shared/repositories/device-auth.repository.js';
import { AdminAuthService } from '#src/server/shared/services/admin-auth.service.js';
import { DeviceAuthService } from '#src/server/shared/services/device-auth.service.js';
import { HashService } from '#src/server/shared/services/hash.service.js';

import type { AppConfig } from './app-dependencies.js';
import type { AppDependencies } from './app-dependencies.js';

/**
 * Register all controller, service, and repository classes into the Awilix
 * dependency container.
 */
function registerDependencies(
  dependencyContainer: AwilixContainer,
  config: AppConfig,
) {
  dependencyContainer.register({
    // Config values
    baseConfig: asValue(config.baseConfig),
    adminAuthConfig: asValue(config.adminAuthConfig),
    dbClientConfig: asValue(config.dbClientConfig),

    // Database
    dbClient: asClass(DBClient, { lifetime: Lifetime.SINGLETON }),

    // Shared services
    hashService: asClass(HashService, { lifetime: Lifetime.SINGLETON }),
    adminAuthService: asClass(AdminAuthService, {
      lifetime: Lifetime.SINGLETON,
    }),
    deviceAuthService: asClass(DeviceAuthService, {
      lifetime: Lifetime.SCOPED,
    }),

    // Shared repositories
    deviceAuthRepository: asClass(DeviceAuthRepository, {
      lifetime: Lifetime.SINGLETON,
    }),

    // Probes
    livenessController: asClass(LivenessController, {
      lifetime: Lifetime.SCOPED,
    }),
    readinessController: asClass(ReadinessController, {
      lifetime: Lifetime.SCOPED,
    }),

    // Room management
    roomManagementController: asClass(RoomManagementController, {
      lifetime: Lifetime.SCOPED,
    }),
    roomManagementService: asClass(RoomManagementService, {
      lifetime: Lifetime.SCOPED,
    }),
    roomManagementRepository: asClass(RoomManagementRepository, {
      lifetime: Lifetime.SINGLETON,
    }),

    // Device management
    deviceManagementController: asClass(DeviceManagementController, {
      lifetime: Lifetime.SCOPED,
    }),
    deviceManagementService: asClass(DeviceManagementService, {
      lifetime: Lifetime.SCOPED,
    }),
    deviceManagementRepository: asClass(DeviceManagementRepository, {
      lifetime: Lifetime.SINGLETON,
    }),
  } as NameAndRegistrationPair<AppDependencies>);
}

export default registerDependencies;
