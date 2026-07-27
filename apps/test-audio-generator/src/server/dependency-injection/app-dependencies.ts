// Need to import so that declare module '@fastify/awilix' below works
import '@fastify/awilix';

import type { BaseDependencies } from '@scribear/base-fastify-server';

import type { AppConfig, BaseConfig } from '#src/app-config/app-config.js';
import type { DevicesController } from '#src/server/features/devices/devices.controller.js';
import type { LivenessController } from '#src/server/features/probes/liveness.controller.js';
import type { ReadinessController } from '#src/server/features/probes/readiness.controller.js';
import type {
  ServiceAuthConfig,
  ServiceAuthService,
} from '#src/server/shared/auth/service-auth.service.js';
import type {
  ClipCatalogConfig,
  ClipCatalogService,
} from '#src/server/shared/clips/clip-catalog.service.js';
import type {
  DeviceRunManagerConfig,
  DeviceRunManagerService,
} from '#src/server/shared/devices/device-run-manager.service.js';

/**
 * All named dependencies available in the Awilix container.
 */
interface AppDependencies extends BaseDependencies {
  // Config
  baseConfig: BaseConfig;
  serviceAuthConfig: ServiceAuthConfig;
  clipCatalogConfig: ClipCatalogConfig;
  deviceRunManagerConfig: DeviceRunManagerConfig;

  // Shared services. All SINGLETON: the run manager holds the two devices'
  // engines and their live runs, and the clip catalog caches sliced audio. A
  // scoped lifetime would give each request a fresh, idle pair of devices.
  serviceAuthService: ServiceAuthService;
  clipCatalogService: ClipCatalogService;
  deviceRunManagerService: DeviceRunManagerService;

  // Controllers
  devicesController: DevicesController;
  livenessController: LivenessController;
  readinessController: ReadinessController;
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
