import {
  type AwilixContainer,
  Lifetime,
  type NameAndRegistrationPair,
  asClass,
  asFunction,
  asValue,
} from 'awilix';

import {
  FleetEventsChannel,
  createRedisSubscriber,
  createTelemetryRedisClient,
} from '@scribear/scribear-redis';

import { AdminDbClient } from '#src/db/admin-db-client.js';
import { AuditController } from '#src/server/features/audit/audit.controller.js';
import { AuthController } from '#src/server/features/auth/auth.controller.js';
import { ConfigCheckController } from '#src/server/features/config-check/config-check.controller.js';
import { ConfigCheckService } from '#src/server/features/config-check/config-check.service.js';
import { DemoRoomController } from '#src/server/features/demo-room/demo-room.controller.js';
import { DeploymentVersionsController } from '#src/server/features/deployment-versions/deployment-versions.controller.js';
import { DeploymentVersionsService } from '#src/server/features/deployment-versions/deployment-versions.service.js';
import { DevicesController } from '#src/server/features/devices/devices.controller.js';
import { FleetController } from '#src/server/features/fleet/fleet.controller.js';
import { HealthController } from '#src/server/features/health/health.controller.js';
import { HealthCheckerService } from '#src/server/features/health/health.service.js';
import { LivenessController } from '#src/server/features/probes/liveness.controller.js';
import { ReadinessController } from '#src/server/features/probes/readiness.controller.js';
import { RoomsController } from '#src/server/features/rooms/rooms.controller.js';
import { SchedulingController } from '#src/server/features/scheduling/scheduling.controller.js';
import { AuditRepository } from '#src/server/shared/repositories/audit.repository.js';
import { AuditService } from '#src/server/shared/services/audit.service.js';
import { AzureOidcAuthService } from '#src/server/shared/services/azure-oidc-auth.service.js';
import { FleetEventsService } from '#src/server/shared/services/fleet-events.service.js';
import { FleetTelemetryService } from '#src/server/shared/services/fleet-telemetry.service.js';
import { LocalAuthService } from '#src/server/shared/services/local-auth.service.js';
import { SessionManagerGatewayService } from '#src/server/shared/services/session-manager-gateway.service.js';
import { SessionService } from '#src/server/shared/services/session.service.js';

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
    sessionManagerGatewayConfig: asValue(config.sessionManagerGatewayConfig),
    sessionConfig: asValue(config.sessionConfig),
    localAuthConfig: asValue(config.localAuthConfig),
    azureAuthConfig: asValue(config.azureAuthConfig),
    rateLimitConfig: asValue(config.rateLimitConfig),
    dbClientConfig: asValue(config.dbClientConfig),
    fleetTelemetryConfig: asValue(config.fleetTelemetryConfig),

    // Database
    dbClient: asClass(AdminDbClient, { lifetime: Lifetime.SINGLETON }),

    // Shared services. Stateful/expensive-to-build services are SINGLETON:
    // the session store must persist across requests; the auth providers hold
    // parsed credentials; the gateway holds the upstream client + admin key.
    localAuthService: asClass(LocalAuthService, {
      lifetime: Lifetime.SINGLETON,
    }),
    azureOidcAuthService: asClass(AzureOidcAuthService, {
      lifetime: Lifetime.SINGLETON,
    }),
    sessionService: asClass(SessionService, { lifetime: Lifetime.SINGLETON }),
    sessionManagerGatewayService: asClass(SessionManagerGatewayService, {
      lifetime: Lifetime.SINGLETON,
    }),
    // SCOPED so it resolves the request-scoped logger (with reqId) for audit.
    auditService: asClass(AuditService, { lifetime: Lifetime.SCOPED }),

    // Shared repositories
    auditRepository: asClass(AuditRepository, {
      lifetime: Lifetime.SINGLETON,
    }),

    // Probes
    livenessController: asClass(LivenessController, {
      lifetime: Lifetime.SCOPED,
    }),
    readinessController: asClass(ReadinessController, {
      lifetime: Lifetime.SCOPED,
    }),

    // Auth
    authController: asClass(AuthController, { lifetime: Lifetime.SCOPED }),

    // Health
    healthCheckerConfig: asValue(config.healthCheckerConfig),
    healthCheckerService: asClass(HealthCheckerService, {
      lifetime: Lifetime.SINGLETON,
    }),
    healthController: asClass(HealthController, { lifetime: Lifetime.SCOPED }),

    // Config check. Depends on fleetTelemetryService and healthCheckerService
    // rather than re-probing: everything it needs about the backplane and the
    // other containers is already observable through those two.
    configCheckConfig: asValue(config.configCheckConfig),
    configCheckService: asClass(ConfigCheckService, {
      lifetime: Lifetime.SINGLETON,
    }),
    configCheckController: asClass(ConfigCheckController, {
      lifetime: Lifetime.SCOPED,
    }),

    // Deployment versions. SINGLETON like the health checker and for the same
    // reason: it holds only its target list, and rebuilding that per request
    // would buy nothing.
    deploymentVersionsConfig: asValue(config.deploymentVersionsConfig),
    deploymentVersionsService: asClass(DeploymentVersionsService, {
      lifetime: Lifetime.SINGLETON,
    }),
    deploymentVersionsController: asClass(DeploymentVersionsController, {
      lifetime: Lifetime.SCOPED,
    }),

    // Rooms
    roomsController: asClass(RoomsController, { lifetime: Lifetime.SCOPED }),

    // Devices
    devicesController: asClass(DevicesController, {
      lifetime: Lifetime.SCOPED,
    }),

    // Scheduling
    schedulingController: asClass(SchedulingController, {
      lifetime: Lifetime.SCOPED,
    }),

    demoRoomController: asClass(DemoRoomController, {
      lifetime: Lifetime.SCOPED,
    }),

    // Audit
    auditController: asClass(AuditController, { lifetime: Lifetime.SCOPED }),

    // Fleet. Built via asFunction, not asClass: the Redis client is `null`
    // when REDIS_URL is unset (rather than never resolving at all), and
    // `FleetTelemetryService`'s constructor param is deliberately not a named
    // `AppDependencies` member for that value — see the class doc comment.
    // The client itself is built once and reused across requests; unset means
    // it never opens a connection at all rather than one that retries forever
    // against an address it was never given (mirrors node-server's
    // telemetryRedisClient). Two named parameters, not a destructured object:
    // Awilix is in CLASSIC mode, which resolves by parameter name, and a
    // destructured param would silently resolve to undefined.
    fleetTelemetryService: asFunction(
      (
        fleetTelemetryConfig: AppDependencies['fleetTelemetryConfig'],
        logger: AppDependencies['logger'],
      ) =>
        new FleetTelemetryService(
          fleetTelemetryConfig.redisUrl === ''
            ? null
            : createTelemetryRedisClient(fleetTelemetryConfig.redisUrl),
          logger,
        ),
      { lifetime: Lifetime.SINGLETON },
    ),
    // Same null-subscriber pattern as `fleetTelemetryService` above, reusing
    // the same `REDIS_URL` — one backplane, two halves (snapshot keys, and
    // this pub/sub channel). Subscribed once, on first resolution, by
    // `FleetEventsService`'s own constructor rather than here.
    fleetEventsService: asFunction(
      (
        fleetTelemetryConfig: AppDependencies['fleetTelemetryConfig'],
        logger: AppDependencies['logger'],
      ) =>
        new FleetEventsService(
          fleetTelemetryConfig.redisUrl === ''
            ? null
            : createRedisSubscriber(
                FleetEventsChannel,
                fleetTelemetryConfig.redisUrl,
              ),
          logger,
        ),
      { lifetime: Lifetime.SINGLETON },
    ),
    fleetController: asClass(FleetController, { lifetime: Lifetime.SCOPED }),
  } as NameAndRegistrationPair<AppDependencies>);
}

export default registerDependencies;
