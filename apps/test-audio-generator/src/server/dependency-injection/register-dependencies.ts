import { type AwilixContainer, Lifetime, asClass, asValue } from 'awilix';

import { DevicesController } from '#src/server/features/devices/devices.controller.js';
import { LivenessController } from '#src/server/features/probes/liveness.controller.js';
import { ReadinessController } from '#src/server/features/probes/readiness.controller.js';
import { ServiceAuthService } from '#src/server/shared/auth/service-auth.service.js';
import { ClipCatalogService } from '#src/server/shared/clips/clip-catalog.service.js';
import { DeviceRunManagerService } from '#src/server/shared/devices/device-run-manager.service.js';

import type { AppConfig } from './app-dependencies.js';

/**
 * Register all controller and service classes into the Awilix container.
 *
 * Awilix runs in CLASSIC injection mode here, resolving constructor
 * dependencies by PARAMETER NAME. Every constructor parameter is named to match
 * its registration key exactly (`deviceRunManagerConfig`, `clipCatalogService`,
 * …); renaming a parameter silently injects `undefined`.
 */
function registerDependencies(
  dependencyContainer: AwilixContainer,
  config: AppConfig,
) {
  dependencyContainer.register({
    // Config values
    baseConfig: asValue(config.baseConfig),
    serviceAuthConfig: asValue(config.serviceAuthConfig),
    clipCatalogConfig: asValue(config.clipCatalogConfig),
    deviceRunManagerConfig: asValue(config.deviceRunManagerConfig),

    // Shared services
    serviceAuthService: asClass(ServiceAuthService, {
      lifetime: Lifetime.SINGLETON,
    }),
    clipCatalogService: asClass(ClipCatalogService, {
      lifetime: Lifetime.SINGLETON,
    }),
    deviceRunManagerService: asClass(DeviceRunManagerService, {
      lifetime: Lifetime.SINGLETON,
    }),

    // Controllers are per-request scoped, matching the other services.
    devicesController: asClass(DevicesController, {
      lifetime: Lifetime.SCOPED,
    }),
    livenessController: asClass(LivenessController, {
      lifetime: Lifetime.SCOPED,
    }),
    readinessController: asClass(ReadinessController, {
      lifetime: Lifetime.SCOPED,
    }),
  });
}

export default registerDependencies;
