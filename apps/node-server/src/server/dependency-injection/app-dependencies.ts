// Need to import so that declare module '@fastify/awilix' below works
import '@fastify/awilix';

import type { BaseDependencies } from '@scribear/base-fastify-server';
import type { TelemetryRedisClient } from '@scribear/scribear-redis';
import type { SessionManagerClient } from '@scribear/session-manager-client';
import type { TranscriptionServiceClient } from '@scribear/transcription-service-client';

import type {
  AppConfig,
  BaseConfig,
  SessionManagerClientConfig,
  TelemetryPublisherConfig,
  TranscriptionServiceClientConfig,
} from '#src/app-config/app-config.js';
import type { LivenessController } from '#src/server/features/probes/liveness.controller.js';
import type { ReadinessController } from '#src/server/features/probes/readiness.controller.js';
import type { StatusController } from '#src/server/features/status/status.controller.js';
import type { RedisTelemetryPublisher } from '#src/server/features/telemetry/redis-telemetry-publisher.service.js';
import type {
  SessionConfigPollFactory,
  TranscriptionOrchestratorService,
} from '#src/server/features/transcription-stream/transcription-orchestrator.service.js';
import type { TranscriptionStreamController } from '#src/server/features/transcription-stream/transcription-stream.controller.js';
import type { EventBusService } from '#src/server/shared/services/event-bus.service.js';
import type { NodeServerMetricsService } from '#src/server/shared/services/node-server-metrics.service.js';
import type {
  ServiceAuthConfig,
  ServiceAuthService,
} from '#src/server/shared/services/service-auth.service.js';
import type {
  SessionTokenConfig,
  SessionTokenService,
} from '#src/server/shared/services/session-token.service.js';
import type { StatusSnapshotService } from '#src/server/shared/services/status-snapshot.service.js';

/**
 * All named dependencies available in the Awilix container.
 */
interface AppDependencies extends BaseDependencies {
  // Config
  baseConfig: BaseConfig;
  serviceAuthConfig: ServiceAuthConfig;
  sessionTokenConfig: SessionTokenConfig;
  sessionManagerClientConfig: SessionManagerClientConfig;
  transcriptionServiceClientConfig: TranscriptionServiceClientConfig;
  telemetryPublisherConfig: TelemetryPublisherConfig;

  // Shared services
  serviceAuthService: ServiceAuthService;
  sessionTokenService: SessionTokenService;
  eventBusService: EventBusService;
  nodeServerMetricsService: NodeServerMetricsService;
  statusSnapshotService: StatusSnapshotService;

  // Outbound clients
  sessionManagerClient: SessionManagerClient;
  transcriptionServiceClient: TranscriptionServiceClient;
  telemetryRedisClient: TelemetryRedisClient;

  // Probes
  livenessController: LivenessController;
  readinessController: ReadinessController;

  // Status
  statusController: StatusController;

  // Telemetry
  redisTelemetryPublisher: RedisTelemetryPublisher;

  // Transcription stream
  sessionConfigPollFactory: SessionConfigPollFactory;
  transcriptionOrchestratorService: TranscriptionOrchestratorService;
  transcriptionStreamController: TranscriptionStreamController;
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
