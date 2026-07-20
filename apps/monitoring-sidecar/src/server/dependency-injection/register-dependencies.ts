import { type AwilixContainer, Lifetime, asClass, asValue } from 'awilix';

import { AudioMeterController } from '#src/server/features/audio-meter/audio-meter.controller.js';
import { MetricsController } from '#src/server/features/metrics/metrics.controller.js';
import { LivenessController } from '#src/server/features/probes/liveness.controller.js';
import { ReadinessController } from '#src/server/features/probes/readiness.controller.js';
import { AlertEvaluatorService } from '#src/server/shared/alerts/alert-evaluator.service.js';
import { DEFAULT_RULES } from '#src/server/shared/alerts/alert-rules.js';
import { CanaryAuthClient } from '#src/server/shared/canary/canary-auth.js';
import { CanaryRunnerService } from '#src/server/shared/canary/canary-runner.service.js';
import { DockerLogSource } from '#src/server/shared/log-ingest/docker-log-source.js';
import { LogIngestService } from '#src/server/shared/log-ingest/log-ingest.service.js';
import { MetricsRegistry } from '#src/server/shared/metrics/metrics-registry.service.js';
import { NodeStatusPollerService } from '#src/server/shared/node-status/node-status-poller.service.js';
import { ProbePollerService } from '#src/server/shared/probes/probe-poller.service.js';
import { TranscriptionMetricsPollerService } from '#src/server/shared/transcription-metrics/transcription-metrics-poller.service.js';

import type { AppConfig } from './app-dependencies.js';

/**
 * Register all controller and service classes into the Awilix container.
 *
 * Note Awilix runs in CLASSIC injection mode here, resolving constructor
 * dependencies by PARAMETER NAME. Every constructor parameter above is named to
 * match its registration key exactly (`metricsRegistry`, `probePollerService`,
 * …); renaming a parameter silently injects `undefined`.
 */
function registerDependencies(
  dependencyContainer: AwilixContainer,
  config: AppConfig,
  expectedTranscript: string,
  audioMeterPage: string,
) {
  dependencyContainer.register({
    // Config values
    baseConfig: asValue(config.baseConfig),
    logIngestConfig: asValue(config.logIngestConfig),
    dockerLogSourceConfig: asValue(config.dockerLogSourceConfig),
    probePollerConfig: asValue(config.probePollerConfig),
    nodeStatusPollerConfig: asValue(config.nodeStatusPollerConfig),
    transcriptionMetricsPollerConfig: asValue(
      config.transcriptionMetricsPollerConfig,
    ),
    alertThresholds: asValue(config.alertThresholds),
    canaryAuthConfig: asValue(config.canaryAuthConfig),
    canaryRunnerConfig: asValue(config.canaryRunnerConfig(expectedTranscript)),
    // Registered explicitly rather than relying on the constructor default:
    // Awilix CLASSIC mode resolves every constructor parameter by name and
    // fails on an unregistered one, default value or not.
    alertRules: asValue(DEFAULT_RULES),

    // Shared services. All SINGLETON: the registry holds every counter, and the
    // ingest/poller/source own long-lived state and streams. A scoped lifetime
    // would silently reset metrics on each request.
    metricsRegistry: asClass(MetricsRegistry, {
      lifetime: Lifetime.SINGLETON,
    }),
    logIngestService: asClass(LogIngestService, {
      lifetime: Lifetime.SINGLETON,
    }),
    dockerLogSource: asClass(DockerLogSource, {
      lifetime: Lifetime.SINGLETON,
    }),
    probePollerService: asClass(ProbePollerService, {
      lifetime: Lifetime.SINGLETON,
    }),
    transcriptionMetricsPollerService: asClass(
      TranscriptionMetricsPollerService,
      {
        lifetime: Lifetime.SINGLETON,
      },
    ),
    nodeStatusPollerService: asClass(NodeStatusPollerService, {
      lifetime: Lifetime.SINGLETON,
    }),
    canaryAuthClient: asClass(CanaryAuthClient, {
      lifetime: Lifetime.SINGLETON,
    }),
    canaryRunnerService: asClass(CanaryRunnerService, {
      lifetime: Lifetime.SINGLETON,
    }),
    alertEvaluatorService: asClass(AlertEvaluatorService, {
      lifetime: Lifetime.SINGLETON,
    }),

    // Controllers are per-request scoped, matching the other services.
    livenessController: asClass(LivenessController, {
      lifetime: Lifetime.SCOPED,
    }),
    readinessController: asClass(ReadinessController, {
      lifetime: Lifetime.SCOPED,
    }),
    metricsController: asClass(MetricsController, {
      lifetime: Lifetime.SCOPED,
    }),
    // The one controller registered as an instance: it holds a single
    // immutable string read at startup and has no per-request state, and the
    // container deliberately carries no bare-string values for CLASSIC mode to
    // resolve by name.
    audioMeterController: asValue(new AudioMeterController(audioMeterPage)),
  });
}

export default registerDependencies;
