import { createBaseServer } from '@scribear/base-fastify-server';

import type { AppConfig } from '#src/app-config/app-config.js';

import type { AppDependencies } from './dependency-injection/app-dependencies.js';
import registerDependencies from './dependency-injection/register-dependencies.js';
import { devicesRouter } from './features/devices/devices.router.js';
import { probesRouter } from './features/probes/probes.router.js';

export interface CreateServerOptions {
  /**
   * Skip the background room refresh and the shutdown hook that stops the
   * devices.
   *
   * Integration tests drive the run manager directly; letting it reach out to
   * session-manager on a timer would make them depend on the machine they run
   * on, and the refresh is covered separately.
   */
  startBackgroundWork?: boolean;
}

/**
 * Initializes the test-audio generator: base server, DI, routes, and — unless
 * disabled — the background room refresh and the shutdown that stops both
 * devices.
 *
 * Async with nothing to await, matching the `createServer` signature every
 * other service exposes so callers and tests can treat them uniformly. The
 * sidecar's reads its fixtures here and genuinely awaits; this one loads audio
 * lazily, on the first run that asks for a clip, because a five-minute clip
 * built at startup would delay readiness for a device nobody may start.
 *
 * Hence the `require-await` suppression: the signature is chosen for uniformity
 * across services, not derived from what this body happens to do today.
 */
// eslint-disable-next-line @typescript-eslint/require-await
async function createServer(
  config: AppConfig,
  options: CreateServerOptions = {},
) {
  const startBackgroundWork = options.startBackgroundWork ?? true;

  const { logger, dependencyContainer, fastify } = createBaseServer(
    config.baseConfig.logLevel,
  );

  registerDependencies(dependencyContainer, config);

  // Resolved eagerly rather than on the first request: `ServiceAuthService`
  // refuses to construct on an empty or placeholder key, and that must stop the
  // process at startup rather than turning into a 500 on the first call — by
  // which time the service has been sitting there apparently healthy, admitting
  // anyone who sent `Authorization: Bearer `.
  dependencyContainer.resolve<AppDependencies['serviceAuthService']>(
    'serviceAuthService',
  );

  fastify.register(probesRouter);
  fastify.register(devicesRouter);

  if (startBackgroundWork) {
    const deviceRunManagerService = dependencyContainer.resolve<
      AppDependencies['deviceRunManagerService']
    >('deviceRunManagerService');

    fastify.addHook('onReady', () => {
      deviceRunManagerService.startRoomRefresh();
    });

    // A shutdown that left a run going would keep frames on the wire from a
    // process no longer answering for them.
    fastify.addHook('onClose', async () => {
      await deviceRunManagerService.shutdown();
    });
  }

  return { logger, fastify };
}

export default createServer;
