// Need to import so that declare module '@fastify/awilix' below works
import '@fastify/awilix';

import type { BaseDependencies } from '@scribear/base-fastify-server';
import type { SessionManagerClient } from '@scribear/session-manager-client';
import type { TranscriptionServiceClient } from '@scribear/transcription-service-client';

import type {
  AppConfig,
  BaseConfig,
  SessionManagerClientConfig,
  TranscriptionServiceClientConfig,
} from '#src/app-config/app-config.js';
import type { LivenessController } from '#src/server/features/probes/liveness.controller.js';
import type { ReadinessController } from '#src/server/features/probes/readiness.controller.js';
import type {
  SessionConfigPollFactory,
  TranscriptionOrchestratorService,
} from '#src/server/features/transcription-stream/transcription-orchestrator.service.js';
import type { TranscriptionStreamController } from '#src/server/features/transcription-stream/transcription-stream.controller.js';
import type { EventBusService } from '#src/server/shared/services/event-bus.service.js';
import type {
  SessionTokenConfig,
  SessionTokenService,
} from '#src/server/shared/services/session-token.service.js';

/**
 * All named dependencies available in the Awilix container.
 */
interface AppDependencies extends BaseDependencies {
  // Config
  baseConfig: BaseConfig;
  sessionTokenConfig: SessionTokenConfig;
  sessionManagerClientConfig: SessionManagerClientConfig;
  transcriptionServiceClientConfig: TranscriptionServiceClientConfig;

  // Shared services
  sessionTokenService: SessionTokenService;
  eventBusService: EventBusService;

  // Outbound clients
  sessionManagerClient: SessionManagerClient;
  transcriptionServiceClient: TranscriptionServiceClient;

  // Probes
  livenessController: LivenessController;
  readinessController: ReadinessController;

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
