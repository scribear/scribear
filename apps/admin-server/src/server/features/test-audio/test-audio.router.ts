import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { csrfHook } from '#src/server/shared/hooks/csrf.hook.js';
import { requireRole } from '#src/server/shared/hooks/require-role.hook.js';
import { requireSessionHook } from '#src/server/shared/hooks/require-session.hook.js';
import { ROLE_READ_WRITE } from '#src/server/shared/types/identity.js';

import {
  LIST_TEST_AUDIO_ROUTE,
  START_DEVICE_INPUT,
  START_DEVICE_ROUTE,
  STOP_DEVICE_INPUT,
  STOP_DEVICE_ROUTE,
  UPDATE_PARAMS_INPUT,
  UPDATE_PARAMS_ROUTE,
} from './test-audio.schema.js';

export function testAudioRouter(fastify: BaseFastifyInstance) {
  // Reads: any authenticated session.
  const readGuards = [requireSessionHook];
  // Mutations: authenticated + CSRF + read-write role. These point a synthetic
  // source device at a real room, so they are guarded exactly as `rooms` is.
  const writeGuards = [
    requireSessionHook,
    csrfHook,
    requireRole(ROLE_READ_WRITE),
  ];

  fastify.route({
    ...LIST_TEST_AUDIO_ROUTE,
    preHandler: readGuards,
    handler: resolveHandler('testAudioController', 'list'),
  });

  fastify.route({
    ...START_DEVICE_ROUTE,
    schema: START_DEVICE_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('testAudioController', 'start'),
  });

  fastify.route({
    ...STOP_DEVICE_ROUTE,
    schema: STOP_DEVICE_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('testAudioController', 'stop'),
  });

  fastify.route({
    ...UPDATE_PARAMS_ROUTE,
    schema: UPDATE_PARAMS_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('testAudioController', 'updateParams'),
  });
}
