// Need to import so that declare module '@fastify/awilix' below works
import '@fastify/awilix';

import type { BaseDependencies } from '@scribear/base-fastify-server';

import type { AppConfig, BaseConfig } from '#src/app-config/app-config.js';
import type { AudioMeterController } from '#src/server/features/audio-meter/audio-meter.controller.js';
import type { MetricsController } from '#src/server/features/metrics/metrics.controller.js';
import type { LivenessController } from '#src/server/features/probes/liveness.controller.js';
import type { ReadinessController } from '#src/server/features/probes/readiness.controller.js';
import type { AlertEvaluatorService } from '#src/server/shared/alerts/alert-evaluator.service.js';
import type {
  AlertRule,
  AlertThresholds,
} from '#src/server/shared/alerts/alert-rules.js';
import type {
  CanaryAuthClient,
  CanaryAuthConfig,
} from '#src/server/shared/canary/canary-auth.js';
import type {
  CanaryRunnerConfig,
  CanaryRunnerService,
} from '#src/server/shared/canary/canary-runner.service.js';
import type {
  DockerLogSource,
  DockerLogSourceConfig,
} from '#src/server/shared/log-ingest/docker-log-source.js';
import type {
  LogIngestConfig,
  LogIngestService,
} from '#src/server/shared/log-ingest/log-ingest.service.js';
import type { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';
import type {
  NodeStatusPollerConfig,
  NodeStatusPollerService,
} from '#src/server/shared/node-status/node-status-poller.service.js';
import type {
  ProbePollerConfig,
  ProbePollerService,
} from '#src/server/shared/probes/probe-poller.service.js';

/**
 * All named dependencies available in the Awilix container.
 */
interface AppDependencies extends BaseDependencies {
  // Config
  baseConfig: BaseConfig;
  logIngestConfig: LogIngestConfig;
  dockerLogSourceConfig: DockerLogSourceConfig;
  probePollerConfig: ProbePollerConfig;
  nodeStatusPollerConfig: NodeStatusPollerConfig;
  alertThresholds: AlertThresholds;
  alertRules: readonly AlertRule[];
  canaryAuthConfig: CanaryAuthConfig;
  canaryRunnerConfig: CanaryRunnerConfig;

  // Shared services
  metricsRegistry: MetricsRegistry;
  logIngestService: LogIngestService;
  dockerLogSource: DockerLogSource;
  probePollerService: ProbePollerService;
  nodeStatusPollerService: NodeStatusPollerService;
  canaryAuthClient: CanaryAuthClient;
  canaryRunnerService: CanaryRunnerService;
  alertEvaluatorService: AlertEvaluatorService;

  // Probes
  livenessController: LivenessController;
  readinessController: ReadinessController;

  // Metrics
  metricsController: MetricsController;

  // Standalone audio meter (A4)
  audioMeterController: AudioMeterController;
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
