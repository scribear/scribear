import fastifyCookie from '@fastify/cookie';

import { createBaseServer } from '@scribear/base-fastify-server';

import type { AppConfig } from '#src/app-config/app-config.js';
// Side-effect import: brings the FastifyRequest augmentation (adminSession /
// adminIdentity) into the program.
import '#src/server/shared/types/fastify-augmentation.js';

import type { AppDependencies } from './dependency-injection/app-dependencies.js';
import registerDependencies from './dependency-injection/register-dependencies.js';
import { auditRouter } from './features/audit/audit.router.js';
import { authRouter } from './features/auth/auth.router.js';
import { configCheckRouter } from './features/config-check/config-check.router.js';
import { demoRoomRouter } from './features/demo-room/demo-room.router.js';
import { deploymentVersionsRouter } from './features/deployment-versions/deployment-versions.router.js';
import { devicesRouter } from './features/devices/devices.router.js';
import { fleetRouter } from './features/fleet/fleet.router.js';
import { healthRouter } from './features/health/health.router.js';
import { probesRouter } from './features/probes/probes.router.js';
import { roomsRouter } from './features/rooms/rooms.router.js';
import { schedulingRouter } from './features/scheduling/scheduling.router.js';
import adminErrorHandler from './plugins/error-handler.plugin.js';
import { registerRateLimit } from './plugins/rate-limit.plugin.js';

/**
 * Initializes the admin BFF: base server + cookie/session, rate limiting, DI,
 * and the `/api/admin/v1` routes.
 */
async function createServer(config: AppConfig) {
  // Trust exactly ONE proxy hop (nginx). This makes `req.ip` the client IP
  // nginx appended to `X-Forwarded-For` — which a client cannot spoof — rather
  // than the leftmost (client-supplied) entry. Correct keying for rate limits.
  const { logger, dependencyContainer, fastify } = createBaseServer(
    config.baseConfig.logLevel,
    { trustProxy: 1 },
  );

  // Override the base error handler so every error becomes an envelope.
  // Registered before routes and after the base server so this handler wins.
  await fastify.register(adminErrorHandler);

  // Cookie signing secret (session cookie is set with `signed: true`).
  await fastify.register(fastifyCookie, { secret: config.cookieSecret });

  // Rate limiting must be registered before routes so per-route overrides apply.
  await registerRateLimit(fastify, config.rateLimitConfig);

  registerDependencies(dependencyContainer, config);

  fastify.register(probesRouter);
  fastify.register(healthRouter);
  fastify.register(configCheckRouter);
  fastify.register(deploymentVersionsRouter);
  fastify.register(authRouter, {
    loginMax: config.rateLimitConfig.loginMax,
    loginWindowMs: config.rateLimitConfig.loginWindowMs,
  });
  fastify.register(roomsRouter);
  fastify.register(devicesRouter);
  fastify.register(schedulingRouter);
  fastify.register(demoRoomRouter);
  fastify.register(auditRouter);
  fastify.register(fleetRouter);

  const dbClient =
    dependencyContainer.resolve<AppDependencies['dbClient']>('dbClient');

  // Apply admin-owned migrations (audit log) once, at startup.
  fastify.addHook('onReady', async () => {
    await dbClient.migrateToLatest();
  });

  // Drain the pg pool on shutdown.
  fastify.addHook('onClose', async () => {
    await dbClient.destroy();
  });

  // Close the fleet telemetry Redis connection on shutdown, if one was ever
  // opened. Resolving here (rather than eagerly at boot) is enough: the
  // service opens no connection until REDIS_URL is set, so this is a no-op
  // when telemetry is disabled.
  fastify.addHook('onClose', async () => {
    const fleetTelemetryService = dependencyContainer.resolve<
      AppDependencies['fleetTelemetryService']
    >('fleetTelemetryService');
    await fleetTelemetryService.close();
  });

  // Same lazy-resolve, no-op-if-never-opened shutdown as the fleet telemetry
  // connection above, for the fleet events subscriber.
  fastify.addHook('onClose', async () => {
    const fleetEventsService =
      dependencyContainer.resolve<AppDependencies['fleetEventsService']>(
        'fleetEventsService',
      );
    await fleetEventsService.close();
  });

  return { logger, fastify };
}

export default createServer;
