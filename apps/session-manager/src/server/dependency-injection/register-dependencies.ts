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
import { MaterializationWorker } from '#src/server/features/schedule-management/materialization.worker.js';
import { ScheduleManagementController } from '#src/server/features/schedule-management/schedule-management.controller.js';
import { ScheduleManagementRepository } from '#src/server/features/schedule-management/schedule-management.repository.js';
import { ScheduleManagementService } from '#src/server/features/schedule-management/schedule-management.service.js';
import { DeviceAuthRepository } from '#src/server/shared/repositories/device-auth.repository.js';
import { AdminAuthService } from '#src/server/shared/services/admin-auth.service.js';
import { DeviceAuthService } from '#src/server/shared/services/device-auth.service.js';
import { EventBusService } from '#src/server/shared/services/event-bus.service.js';
import { HashService } from '#src/server/shared/services/hash.service.js';
import { ServiceAuthService } from '#src/server/shared/services/service-auth.service.js';

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
    serviceAuthConfig: asValue(config.serviceAuthConfig),
    dbClientConfig: asValue(config.dbClientConfig),
    materializationWorkerConfig: asValue(config.materializationWorkerConfig),

    // Database
    dbClient: asClass(DBClient, { lifetime: Lifetime.SINGLETON }),

    // Shared services
    hashService: asClass(HashService, { lifetime: Lifetime.SINGLETON }),
    adminAuthService: asClass(AdminAuthService, {
      lifetime: Lifetime.SINGLETON,
    }),
    serviceAuthService: asClass(ServiceAuthService, {
      lifetime: Lifetime.SINGLETON,
    }),
    deviceAuthService: asClass(DeviceAuthService, {
      lifetime: Lifetime.SCOPED,
    }),
    eventBusService: asClass(EventBusService, {
      lifetime: Lifetime.SINGLETON,
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

    // Schedule management
    scheduleManagementController: asClass(ScheduleManagementController, {
      lifetime: Lifetime.SCOPED,
    }),
    scheduleManagementService: asClass(ScheduleManagementService, {
      lifetime: Lifetime.SCOPED,
    }),
    scheduleManagementRepository: asClass(ScheduleManagementRepository, {
      lifetime: Lifetime.SINGLETON,
    }),
    // SCOPED rather than SINGLETON because the worker depends on
    // `scheduleManagementService`, which is SCOPED. Awilix forbids a longer
    // lifetime depending on a shorter one. Resolving the worker at startup
    // from the root container produces a single instance for the process,
    // with its scoped dependencies cached on the same root scope.
    materializationWorker: asClass(MaterializationWorker, {
      lifetime: Lifetime.SCOPED,
    }),
  } as NameAndRegistrationPair<AppDependencies>);
}

export default registerDependencies;
