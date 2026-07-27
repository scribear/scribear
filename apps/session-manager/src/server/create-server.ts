import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';

import { HttpError, createBaseServer } from '@scribear/base-fastify-server';

import type { AppConfig } from '#src/app-config/app-config.js';

import type { AppDependencies } from './dependency-injection/app-dependencies.js';
import registerDependencies from './dependency-injection/register-dependencies.js';
import { databaseRouter } from './features/database/database.router.js';
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
  fastify.register(databaseRouter);

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

  // Operator test-audio rooms. Resolved and run only when
  // TEST_AUDIO_DEVICE_SECRET is set; unset seeds nothing and leaves the
  // generator's two devices reporting `configured: false`, which is the state a
  // deployment that has not asked for the feature is already in.
  //
  // This is what replaced deployment/provision-test-audio.sh: the rooms, the
  // devices, their credentials and their standing sessions are all seeded here,
  // so there is nothing for an operator to register, activate, copy or paste.
  if (config.testAudioRoomsConfig.enabled) {
    const testAudioRoomsSeeder = dependencyContainer.resolve<
      AppDependencies['testAudioRoomsSeeder']
    >('testAudioRoomsSeeder');
    fastify.addHook('onReady', async () => {
      // As with the demo room: a transient seeding failure must not take down
      // an otherwise-healthy instance over a test fixture.
      try {
        await testAudioRoomsSeeder.seed();
      } catch (err) {
        logger.error({ err }, 'test-audio rooms: seeding failed');
      }
    });
  }

  // Monitoring canary room. Resolved and run only when CANARY_DEVICE_SECRET is
  // set; unset seeds nothing and leaves the sidecar's canary switched off,
  // which is where a deployment that never provisioned a canary device already
  // was.
  //
  // This is what replaced MONITORING_CANARY_DEVICE_TOKEN: the room, the device,
  // its credential and its standing session are all seeded here, so there is
  // nothing for an operator to register, activate, copy or paste - and no way
  // to point the canary at a teaching room by mistake.
  if (config.canaryRoomConfig.enabled) {
    const canaryRoomSeeder =
      dependencyContainer.resolve<AppDependencies['canaryRoomSeeder']>(
        'canaryRoomSeeder',
      );
    fastify.addHook('onReady', async () => {
      // As with the other two seeders: a transient seeding failure must not
      // take down an otherwise-healthy instance over a monitoring fixture.
      try {
        await canaryRoomSeeder.seed();
      } catch (err) {
        logger.error({ err }, 'monitoring canary room: seeding failed');
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
