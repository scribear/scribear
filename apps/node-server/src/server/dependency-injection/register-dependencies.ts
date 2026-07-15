import {
  type AwilixContainer,
  Lifetime,
  type NameAndRegistrationPair,
  asClass,
  asFunction,
  asValue,
} from 'awilix';

import { LongPollClient } from '@scribear/base-long-poll-client';
import { createSessionManagerClient } from '@scribear/session-manager-client';
import {
  SESSION_CONFIG_STREAM_ROUTE,
  SESSION_CONFIG_STREAM_SCHEMA,
} from '@scribear/session-manager-schema';
import { createTranscriptionServiceClient } from '@scribear/transcription-service-client';

import { LivenessController } from '#src/server/features/probes/liveness.controller.js';
import { ReadinessController } from '#src/server/features/probes/readiness.controller.js';
import {
  type SessionConfigPollFactory,
  TranscriptionOrchestratorService,
} from '#src/server/features/transcription-stream/transcription-orchestrator.service.js';
import { TranscriptionStreamController } from '#src/server/features/transcription-stream/transcription-stream.controller.js';
import { EventBusService } from '#src/server/shared/services/event-bus.service.js';
import { SessionTokenService } from '#src/server/shared/services/session-token.service.js';

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
    sessionTokenConfig: asValue(config.sessionTokenConfig),
    sessionManagerClientConfig: asValue(config.sessionManagerClientConfig),
    transcriptionServiceClientConfig: asValue(
      config.transcriptionServiceClientConfig,
    ),

    // Shared services
    sessionTokenService: asClass(SessionTokenService, {
      lifetime: Lifetime.SINGLETON,
    }),
    eventBusService: asClass(EventBusService, {
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
  } as NameAndRegistrationPair<AppDependencies>);
}

export default registerDependencies;
