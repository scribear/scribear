// Need to import so that declare module '@fastify/awilix' below works
import '@fastify/awilix';
import {
  type AwilixContainer,
  Lifetime,
  type NameAndRegistrationPair,
  asClass,
  asValue,
} from 'awilix';

import type { BaseDependencies } from '@scribear/base-fastify-server';

import type AppConfig from '../../app-config/app-config.js';
import { HealthcheckController } from '../features/healthcheck/healthcheck.controller.js';
import {
  JwtService,
  type JwtServiceConfig,
} from '../features/session-streaming/jwt.service.js';
import { SessionStreamingController } from '../features/session-streaming/session-streaming.controller.js';
import { SessionStreamingService } from '../features/session-streaming/session-streaming.service.js';
import { StreamingEventBusService } from '../features/session-streaming/streaming-event-bus.service.js';
import {
  TranscriptionServiceManager,
  type TranscriptionServiceManagerConfig,
} from '../features/session-streaming/transcription-service-manager.js';

/**
 * Define types for entities in dependency container
 */
interface AppDependencies extends BaseDependencies {
  // Config
  config: AppConfig;

  // Healthcheck
  healthcheckController: HealthcheckController;

  // JWT Service
  jwtServiceConfig: JwtServiceConfig;
  jwtService: JwtService;

  // Session Streaming
  transcriptionServiceManagerConfig: TranscriptionServiceManagerConfig;
  streamingEventBusService: StreamingEventBusService;
  transcriptionServiceManager: TranscriptionServiceManager;
  sessionStreamingService: SessionStreamingService;
  sessionStreamingController: SessionStreamingController;
}

/**
 * Ensure fastify awilix container is typed correctly
 * @see https://github.com/fastify/fastify-awilix?tab=readme-ov-file#typescript-usage
 */
declare module '@fastify/awilix' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Cradle extends AppDependencies {}

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface RequestCradle extends AppDependencies {}
}

/**
 * Register all controller, service, and repository classes into dependency container
 * @param dependencyContainer Container to load dependencies into
 * @param config AppConfig to be registered into dependency controller
 */
function registerDependencies(
  dependencyContainer: AwilixContainer,
  config: AppConfig,
) {
  dependencyContainer.register({
    // Config
    config: asValue(config),

    // JWT
    jwtServiceConfig: asValue(config.jwtServiceConfig),
    jwtService: asClass(JwtService, { lifetime: Lifetime.SINGLETON }),

    // Healthcheck
    healthcheckController: asClass(HealthcheckController, {
      lifetime: Lifetime.SCOPED,
    }),

    // Session Streaming
    transcriptionServiceManagerConfig: asValue(
      config.transcriptionServiceManagerConfig,
    ),
    streamingEventBusService: asClass(StreamingEventBusService, {
      lifetime: Lifetime.SINGLETON,
    }),
    transcriptionServiceManager: asClass(TranscriptionServiceManager, {
      lifetime: Lifetime.SINGLETON,
    }),
    sessionStreamingService: asClass(SessionStreamingService, {
      lifetime: Lifetime.SCOPED,
    }),
    sessionStreamingController: asClass(SessionStreamingController, {
      lifetime: Lifetime.SCOPED,
    }),
  } as NameAndRegistrationPair<AppDependencies>);
}

export default registerDependencies;
export type { AppDependencies };
