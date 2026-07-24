import {
  type AwilixContainer,
  Lifetime,
  type NameAndRegistrationPair,
  asClass,
  asFunction,
  asValue,
} from 'awilix';

import { LongPollClient } from '@scribear/base-long-poll-client';
import { createTelemetryRedisClient } from '@scribear/scribear-redis';
import { createSessionManagerClient } from '@scribear/session-manager-client';
import {
  SESSION_CONFIG_STREAM_ROUTE,
  SESSION_CONFIG_STREAM_SCHEMA,
} from '@scribear/session-manager-schema';
import { createTranscriptionServiceClient } from '@scribear/transcription-service-client';

import { DemoCaptionSource } from '#src/server/features/demo-room/demo-caption-source.js';
import { LivenessController } from '#src/server/features/probes/liveness.controller.js';
import { ReadinessController } from '#src/server/features/probes/readiness.controller.js';
import { StatusController } from '#src/server/features/status/status.controller.js';
import { RedisTelemetryPublisher } from '#src/server/features/telemetry/redis-telemetry-publisher.service.js';
import {
  type SessionConfigPollFactory,
  TranscriptionOrchestratorService,
} from '#src/server/features/transcription-stream/transcription-orchestrator.service.js';
import { TranscriptionStreamController } from '#src/server/features/transcription-stream/transcription-stream.controller.js';
import { EventBusService } from '#src/server/shared/services/event-bus.service.js';
import { NodeServerMetricsService } from '#src/server/shared/services/node-server-metrics.service.js';
import { ServiceAuthService } from '#src/server/shared/services/service-auth.service.js';
import { SessionTokenService } from '#src/server/shared/services/session-token.service.js';
import { StatusSnapshotService } from '#src/server/shared/services/status-snapshot.service.js';

import type { AppConfig, AppDependencies } from './app-dependencies.js';

/**
 * Register all controller, service, and client classes into the Awilix
 * dependency container.
 */
function registerDependencies(
  dependencyContainer: AwilixContainer,
  config: AppConfig,
) {
  dependencyContainer.register({
    // Config values
    baseConfig: asValue(config.baseConfig),
    serviceAuthConfig: asValue(config.serviceAuthConfig),
    sessionTokenConfig: asValue(config.sessionTokenConfig),
    sessionManagerClientConfig: asValue(config.sessionManagerClientConfig),
    transcriptionServiceClientConfig: asValue(
      config.transcriptionServiceClientConfig,
    ),
    telemetryPublisherConfig: asValue(config.telemetryPublisherConfig),
    demoRoomConfig: asValue(config.demoRoomConfig),

    // Shared services
    serviceAuthService: asClass(ServiceAuthService, {
      lifetime: Lifetime.SINGLETON,
    }),
    sessionTokenService: asClass(SessionTokenService, {
      lifetime: Lifetime.SINGLETON,
    }),
    eventBusService: asClass(EventBusService, {
      lifetime: Lifetime.SINGLETON,
    }),
    // Singleton so counters survive individual connections; the signals it
    // collects originate in both request-scoped and singleton objects.
    nodeServerMetricsService: asClass(NodeServerMetricsService, {
      lifetime: Lifetime.SINGLETON,
    }),
    statusSnapshotService: asClass(StatusSnapshotService, {
      lifetime: Lifetime.SINGLETON,
    }),

    // Outbound clients
    // asFunction in Awilix CLASSIC injection mode resolves dependencies by
    // parameter NAME, so each factory below uses plain named parameters that
    // exactly match registered keys - destructured object patterns silently
    // receive `undefined` and break the resulting service.
    sessionManagerClient: asFunction(
      (
        sessionManagerClientConfig: AppDependencies['sessionManagerClientConfig'],
      ) => createSessionManagerClient(sessionManagerClientConfig.baseUrl),
      { lifetime: Lifetime.SINGLETON },
    ),
    transcriptionServiceClient: asFunction(
      (
        transcriptionServiceClientConfig: AppDependencies['transcriptionServiceClientConfig'],
      ) =>
        createTranscriptionServiceClient(
          transcriptionServiceClientConfig.baseUrl,
        ),
      { lifetime: Lifetime.SINGLETON },
    ),

    // Connects on resolution, so this is deliberately only reachable through
    // the publisher below, which `createServer` resolves solely when a Redis
    // URL is configured. An instance with telemetry switched off opens no
    // connection at all rather than one that retries forever.
    telemetryRedisClient: asFunction(
      (telemetryPublisherConfig: AppDependencies['telemetryPublisherConfig']) =>
        createTelemetryRedisClient(telemetryPublisherConfig.redisUrl),
      { lifetime: Lifetime.SINGLETON },
    ),

    // Long-poll factory for tracking per-session config from Session Manager.
    // Captured here (rather than constructed inside the orchestrator) so
    // unit/integration tests can swap in stubs.
    sessionConfigPollFactory: asFunction(
      (
        sessionManagerClientConfig: AppDependencies['sessionManagerClientConfig'],
      ): SessionConfigPollFactory =>
        (sessionUid: string) =>
          new LongPollClient({
            schema: SESSION_CONFIG_STREAM_SCHEMA,
            route: SESSION_CONFIG_STREAM_ROUTE,
            baseUrl: sessionManagerClientConfig.baseUrl,
            params: { params: { sessionUid } },
            versionParam: 'sinceVersion',
            versionResponseKey: 'sessionConfigVersion',
            headers: {
              authorization: `Bearer ${sessionManagerClientConfig.serviceApiKey}`,
            },
          }),
      { lifetime: Lifetime.SINGLETON },
    ),

    // Probes
    livenessController: asClass(LivenessController, {
      lifetime: Lifetime.SCOPED,
    }),
    readinessController: asClass(ReadinessController, {
      lifetime: Lifetime.SCOPED,
    }),

    // Status
    statusController: asClass(StatusController, {
      lifetime: Lifetime.SCOPED,
    }),

    // Telemetry
    redisTelemetryPublisher: asClass(RedisTelemetryPublisher, {
      lifetime: Lifetime.SINGLETON,
    }),

    // Transcription stream
    transcriptionOrchestratorService: asClass(
      TranscriptionOrchestratorService,
      {
        lifetime: Lifetime.SINGLETON,
      },
    ),
    transcriptionStreamController: asClass(TranscriptionStreamController, {
      lifetime: Lifetime.SCOPED,
    }),

    // Demo caption room. Constructed regardless, but a no-op unless
    // `demoRoomConfig.enabled` (the default); `createServer` only resolves and
    // starts it when enabled.
    demoCaptionSource: asClass(DemoCaptionSource, {
      lifetime: Lifetime.SINGLETON,
    }),
  } as NameAndRegistrationPair<AppDependencies>);
}

export default registerDependencies;
