import { readFile } from 'node:fs/promises';

import { createBaseServer } from '@scribear/base-fastify-server';

import type { AppConfig } from '#src/app-config/app-config.js';

import type { AppDependencies } from './dependency-injection/app-dependencies.js';
import registerDependencies from './dependency-injection/register-dependencies.js';
import { audioMeterRouter } from './features/audio-meter/audio-meter.router.js';
import { metricsRouter } from './features/metrics/metrics.router.js';
import { probesRouter } from './features/probes/probes.router.js';

export interface CreateServerOptions {
  /**
   * Skip attaching to the Docker socket and starting the probe poller.
   *
   * Integration tests drive the ingest and poller directly with fixtures; a
   * real Docker attach would make them environment-dependent and slow.
   */
  startCollectors?: boolean;
}

/**
 * Initializes the monitoring sidecar: base server, DI, routes, and — unless
 * disabled — the log-ingest and probe-polling collectors.
 *
 * Async with nothing to await, matching the `createServer` signature every
 * other service exposes so callers and tests can treat them uniformly.
 */
async function createServer(
  config: AppConfig,
  options: CreateServerOptions = {},
) {
  const startCollectors = options.startCollectors ?? true;

  const { logger, dependencyContainer, fastify } = createBaseServer(
    config.baseConfig.logLevel,
  );

  // The canary's ground truth is read once here rather than inside config, so
  // configuration stays synchronous. A missing file disables scoring instead of
  // preventing startup: the canary's connectivity checks are still valuable
  // without the accuracy proxy.
  let expectedTranscript = '';
  try {
    expectedTranscript = await readFile(config.canaryTranscriptPath, 'utf8');
  } catch (err) {
    logger.warn(
      { err, path: config.canaryTranscriptPath },
      'canary ground-truth transcript unavailable; accuracy scoring disabled',
    );
  }

  // The meter page is a static asset; a deployment that did not ship it should
  // still get its metrics, so a missing file costs the route, not the process.
  let audioMeterPage = '';
  try {
    audioMeterPage = await readFile(config.audioMeterPath, 'utf8');
  } catch (err) {
    logger.warn(
      { err, path: config.audioMeterPath },
      'standalone audio meter page unavailable; A4 route disabled',
    );
  }

  registerDependencies(
    dependencyContainer,
    config,
    expectedTranscript,
    audioMeterPage,
  );

  fastify.register(probesRouter);
  fastify.register(metricsRouter);
  if (audioMeterPage) fastify.register(audioMeterRouter);

  if (startCollectors) {
    const dockerLogSource =
      dependencyContainer.resolve<AppDependencies['dockerLogSource']>(
        'dockerLogSource',
      );
    const probePollerService =
      dependencyContainer.resolve<AppDependencies['probePollerService']>(
        'probePollerService',
      );
    const nodeStatusPollerService = dependencyContainer.resolve<
      AppDependencies['nodeStatusPollerService']
    >('nodeStatusPollerService');
    const canaryRunnerService = dependencyContainer.resolve<
      AppDependencies['canaryRunnerService']
    >('canaryRunnerService');

    fastify.addHook('onReady', async () => {
      // Attaching to container logs is best-effort: if the Docker socket is
      // unavailable the sidecar still serves probe-derived metrics rather than
      // refusing to start. The readiness probe reports the degraded state.
      await dockerLogSource.start();
      probePollerService.start();
      // Source of the connection, upstream and auth metrics since B1.1. It is
      // a no-op when no service API key is configured, and says so once.
      nodeStatusPollerService.start();

      // Likewise best-effort. A bad fixture path or unreadable audio file must
      // not take down the log and probe collectors, which are independently
      // useful and are what the sidecar was originally deployed for.
      try {
        await canaryRunnerService.start();
      } catch (err) {
        logger.error({ err }, 'canary failed to start; A2 checks disabled');
      }
    });

    fastify.addHook('onClose', () => {
      dockerLogSource.stop();
      probePollerService.stop();
      nodeStatusPollerService.stop();
      canaryRunnerService.stop();
    });
  }

  return { logger, fastify };
}

export default createServer;
