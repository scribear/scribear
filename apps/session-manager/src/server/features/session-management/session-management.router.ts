import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  CREATE_SESSION_ROUTE,
  CREATE_SESSION_SCHEMA,
  DEVICE_SESSION_EVENTS_ROUTE,
  DEVICE_SESSION_EVENTS_SCHEMA,
} from '@scribear/session-manager-schema';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { apiKeyAuthHook } from '#src/server/hooks/api-key-auth.hook.js';
import { deviceCookieAuthHook } from '#src/server/hooks/device-cookie-auth.hook.js';

/**
 * Registers session management routes
 * @param fastify Fastify app instance
 */
export function sessionManagementRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...CREATE_SESSION_ROUTE,
    schema: CREATE_SESSION_SCHEMA,
    preHandler: apiKeyAuthHook,
    handler: resolveHandler('sessionManagementController', 'createSession'),
  });

  fastify.route({
    ...DEVICE_SESSION_EVENTS_ROUTE,
    schema: DEVICE_SESSION_EVENTS_SCHEMA,
    preHandler: deviceCookieAuthHook,
    handler: resolveHandler(
      'sessionManagementController',
      'getDeviceSessionEvents',
    ),
  });
}
