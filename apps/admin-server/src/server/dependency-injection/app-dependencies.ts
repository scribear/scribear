// Need to import so that declare module '@fastify/awilix' below works
import '@fastify/awilix';

import type { BaseDependencies } from '@scribear/base-fastify-server';

import type { AppConfig, BaseConfig } from '#src/app-config/app-config.js';
import type {
  AdminDbClient,
  AdminDbClientConfig,
} from '#src/db/admin-db-client.js';
import type { AuditController } from '#src/server/features/audit/audit.controller.js';
import type { AuthController } from '#src/server/features/auth/auth.controller.js';
import type { DevicesController } from '#src/server/features/devices/devices.controller.js';
import type { FleetController } from '#src/server/features/fleet/fleet.controller.js';
import type { HealthController } from '#src/server/features/health/health.controller.js';
import type {
  HealthCheckerConfig,
  HealthCheckerService,
} from '#src/server/features/health/health.service.js';
import type { LivenessController } from '#src/server/features/probes/liveness.controller.js';
import type { ReadinessController } from '#src/server/features/probes/readiness.controller.js';
import type { RoomsController } from '#src/server/features/rooms/rooms.controller.js';
import type { SchedulingController } from '#src/server/features/scheduling/scheduling.controller.js';
import type { RateLimitConfig } from '#src/server/plugins/rate-limit.plugin.js';
import type { AuditRepository } from '#src/server/shared/repositories/audit.repository.js';
import type { AuditService } from '#src/server/shared/services/audit.service.js';
import type {
  AzureAuthConfig,
  AzureOidcAuthService,
} from '#src/server/shared/services/azure-oidc-auth.service.js';
import type { FleetEventsService } from '#src/server/shared/services/fleet-events.service.js';
import type {
  FleetTelemetryConfig,
  FleetTelemetryService,
} from '#src/server/shared/services/fleet-telemetry.service.js';
import type {
  LocalAuthConfig,
  LocalAuthService,
} from '#src/server/shared/services/local-auth.service.js';
import type {
  SessionManagerGatewayConfig,
  SessionManagerGatewayService,
} from '#src/server/shared/services/session-manager-gateway.service.js';
import type {
  SessionConfig,
  SessionService,
} from '#src/server/shared/services/session.service.js';

/**
 * All named dependencies available in the Awilix container.
 */
interface AppDependencies extends BaseDependencies {
  // Config
  baseConfig: BaseConfig;
  sessionManagerGatewayConfig: SessionManagerGatewayConfig;
  sessionConfig: SessionConfig;
  localAuthConfig: LocalAuthConfig;
  azureAuthConfig: AzureAuthConfig;
  rateLimitConfig: RateLimitConfig;
  dbClientConfig: AdminDbClientConfig;

  // Database
  dbClient: AdminDbClient;

  // Shared services
  localAuthService: LocalAuthService;
  azureOidcAuthService: AzureOidcAuthService;
  sessionService: SessionService;
  sessionManagerGatewayService: SessionManagerGatewayService;
  auditService: AuditService;

  // Shared repositories
  auditRepository: AuditRepository;

  // Probes
  livenessController: LivenessController;
  readinessController: ReadinessController;

  // Auth
  authController: AuthController;

  // Health
  healthCheckerConfig: HealthCheckerConfig;
  healthCheckerService: HealthCheckerService;
  healthController: HealthController;

  // Rooms
  roomsController: RoomsController;

  // Devices
  devicesController: DevicesController;

  // Scheduling
  schedulingController: SchedulingController;

  // Audit
  auditController: AuditController;

  // Fleet
  fleetTelemetryConfig: FleetTelemetryConfig;
  fleetTelemetryService: FleetTelemetryService;
  fleetEventsService: FleetEventsService;
  fleetController: FleetController;
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
