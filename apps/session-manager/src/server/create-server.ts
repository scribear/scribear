import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';

import { HttpError, createBaseServer } from '@scribear/base-fastify-server';

import type { AppConfig } from '#src/app-config/app-config.js';

import type { AppDependencies } from './dependency-injection/app-dependencies.js';
import registerDependencies from './dependency-injection/register-dependencies.js';
import { demoRoomRouter } from './features/demo-room/demo-room.router.js';
import { deviceManagementRouter } from './features/device-management/device-management.router.js';
import { probesRouter } from './features/probes/probes.router.js';
import { roomManagementRouter } from './features/room-management/room-management.router.js';
import { scheduleManagementRouter } from './features/schedule-management/schedule-management.router.js';
import { sessionAuthRouter } from './features/session-auth/session-auth.router.js';
import swagger from './plugins/swagger.js';

/**
 * Initializes the Fastify server, registers plugins, dependencies, and routes.
 */
async function createServer(config: AppConfig) {
  const { logger, dependencyContainer, fastify } = createBaseServer(
    // Trust exactly ONE proxy hop (nginx) so `req.ip` is the client IP nginx
    // appended to `X-Forwarded-For` (not spoofable by the client) — correct
    // keying for the per-client rate limits below.
    config.baseConfig.logLevel,
    { trustProxy: 1 },
  );

  if (config.baseConfig.isDevelopment) {
    await fastify.register(swagger);
  }
  fastify.register(fastifyCookie);

  // Rate limiting is opt-in per route (`global: false`); only the
  // unauthenticated credential-exchange routes enable it (see session-auth
  // router). Long-poll and admin/service routes are intentionally unlimited.
  // Throw a BaseHttpError so the base error handler serializes it as 429.
  await fastify.register(fastifyRateLimit, {
    global: false,
    errorResponseBuilder: () =>
      HttpError.rateLimited('Too many requests. Please retry shortly.'),
  });

  registerDependencies(dependencyContainer, config);

  fastify.register(probesRouter);
  fastify.register(deviceManagementRouter);
  fastify.register(roomManagementRouter);
  fastify.register(scheduleManagementRouter);
  fastify.register(sessionAuthRouter);
  fastify.register(demoRoomRouter);

  const materializationWorker = dependencyContainer.resolve<
    AppDependencies['materializationWorker']
  >('materializationWorker');
  fastify.addHook('onReady', () => {
    materializationWorker.start();
  });
  fastify.addHook('onClose', async () => {
    await materializationWorker.stop();
  });

  // Demo caption room. Resolved and run only when enabled - which is the
  // default in every environment; set DEMO_ROOM_ENABLED=false to skip it.
  // Idempotently ensures a demo room/device/session exist and logs a current
  // join code; see `apps/node-server/PLAN-Demo-CAPTION_ROOM.md`.
  if (config.demoRoomConfig.enabled) {
    const demoRoomSeeder =
      dependencyContainer.resolve<AppDependencies['demoRoomSeeder']>(
        'demoRoomSeeder',
      );
    fastify.addHook('onReady', async () => {
      // A seeding failure (e.g. a transient DB error) must not take down an
      // otherwise-healthy instance over a demo feature.
      try {
        await demoRoomSeeder.seed();
      } catch (err) {
        logger.error({ err }, 'demo caption room: seeding failed');
      }
    });
  }

  // Drain the pg pool on shutdown. Without this, in-flight idle clients
  // surface a fatal admin-shutdown error (Postgres 57P01) when the database
  // shuts down before us, and pg-pool re-emits that as an unhandled `error`
  // event on the BoundPool.
  const dbClient =
    dependencyContainer.resolve<AppDependencies['dbClient']>('dbClient');
  fastify.addHook('onClose', async () => {
    await dbClient.destroy();
  });

  return { logger, fastify };
}

export default createServer;
