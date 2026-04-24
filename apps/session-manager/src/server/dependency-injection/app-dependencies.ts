// Need to import so that declare module '@fastify/awilix' below works
import '@fastify/awilix';

import type { BaseDependencies } from '@scribear/base-fastify-server';

import type { AppConfig, BaseConfig } from '#src/app-config/app-config.js';
import type { DBClient, DBClientConfig } from '#src/db/db-client.js';
import type { DeviceManagementController } from '#src/server/features/device-management/device-management.controller.js';
import type { DeviceManagementRepository } from '#src/server/features/device-management/device-management.repository.js';
import type { DeviceManagementService } from '#src/server/features/device-management/device-management.service.js';
import type { LivenessController } from '#src/server/features/probes/liveness.controller.js';
import type { ReadinessController } from '#src/server/features/probes/readiness.controller.js';
import type { RoomManagementController } from '#src/server/features/room-management/room-management.controller.js';
import type { RoomManagementRepository } from '#src/server/features/room-management/room-management.repository.js';
import type { RoomManagementService } from '#src/server/features/room-management/room-management.service.js';
import type { DeviceAuthRepository } from '#src/server/shared/repositories/device-auth.repository.js';
import type { AdminAuthConfig } from '#src/server/shared/services/admin-auth.service.js';
import type { AdminAuthService } from '#src/server/shared/services/admin-auth.service.js';
import type { DeviceAuthService } from '#src/server/shared/services/device-auth.service.js';
import type { HashService } from '#src/server/shared/services/hash.service.js';

/**
 * All named dependencies available in the Awilix container.
 */
interface AppDependencies extends BaseDependencies {
  // Config
  baseConfig: BaseConfig;
  adminAuthConfig: AdminAuthConfig;
  dbClientConfig: DBClientConfig;

  // Database
  dbClient: DBClient;

  // Shared services
  hashService: HashService;
  adminAuthService: AdminAuthService;
  deviceAuthService: DeviceAuthService;

  // Shared repositories
  deviceAuthRepository: DeviceAuthRepository;

  // Probes
  livenessController: LivenessController;
  readinessController: ReadinessController;

  // Room management
  roomManagementController: RoomManagementController;
  roomManagementService: RoomManagementService;
  roomManagementRepository: RoomManagementRepository;

  // Device management
  deviceManagementController: DeviceManagementController;
  deviceManagementService: DeviceManagementService;
  deviceManagementRepository: DeviceManagementRepository;
}

/**
 * Ensure the Fastify Awilix container is typed with AppDependencies.
 * @see https://github.com/fastify/fastify-awilix?tab=readme-ov-file#typescript-usage
 */
declare module '@fastify/awilix' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Cradle extends AppDependencies {}

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface RequestCradle extends AppDependencies {}
}

export type { AppDependencies, AppConfig };
