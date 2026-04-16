import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  CREATE_SESSION_ROUTE,
  CREATE_SESSION_SCHEMA,
  DEVICE_SESSION_EVENTS_ROUTE,
  DEVICE_SESSION_EVENTS_SCHEMA,
  END_SESSION_ROUTE,
  END_SESSION_SCHEMA,
  GET_DEVICE_SESSIONS_ROUTE,
  GET_DEVICE_SESSIONS_SCHEMA,
  GET_SESSION_CONFIG_ROUTE,
  GET_SESSION_CONFIG_SCHEMA,
  GET_SESSION_JOIN_CODE_ROUTE,
  GET_SESSION_JOIN_CODE_SCHEMA,
  REFRESH_SESSION_TOKEN_ROUTE,
  REFRESH_SESSION_TOKEN_SCHEMA,
  SESSION_JOIN_CODE_AUTH_ROUTE,
  SESSION_JOIN_CODE_AUTH_SCHEMA,
  SOURCE_DEVICE_SESSION_AUTH_ROUTE,
  SOURCE_DEVICE_SESSION_AUTH_SCHEMA,
} from '@scribear/session-manager-schema';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { apiKeyAuthHook } from '#src/server/hooks/api-key-auth.hook.js';
import { deviceCookieAuthHook } from '#src/server/hooks/device-cookie-auth.hook.js';
import { nodeServerKeyAuthHook } from '#src/server/hooks/node-server-key-auth.hook.js';

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

  fastify.route({
    ...SESSION_JOIN_CODE_AUTH_ROUTE,
    schema: SESSION_JOIN_CODE_AUTH_SCHEMA,
    handler: resolveHandler('sessionManagementController', 'sessionAuth'),
  });

  fastify.route({
    ...SOURCE_DEVICE_SESSION_AUTH_ROUTE,
    schema: SOURCE_DEVICE_SESSION_AUTH_SCHEMA,
    preHandler: deviceCookieAuthHook,
    handler: resolveHandler(
      'sessionManagementController',
      'sourceDeviceSessionAuth',
    ),
  });

  fastify.route({
    ...REFRESH_SESSION_TOKEN_ROUTE,
    schema: REFRESH_SESSION_TOKEN_SCHEMA,
    handler: resolveHandler(
      'sessionManagementController',
      'refreshSessionToken',
    ),
  });

  fastify.route({
    ...GET_SESSION_JOIN_CODE_ROUTE,
    schema: GET_SESSION_JOIN_CODE_SCHEMA,
    preHandler: deviceCookieAuthHook,
    handler: resolveHandler(
      'sessionManagementController',
      'getSessionJoinCode',
    ),
  });

  fastify.route({
    ...GET_SESSION_CONFIG_ROUTE,
    schema: GET_SESSION_CONFIG_SCHEMA,
    preHandler: nodeServerKeyAuthHook,
    handler: resolveHandler('sessionManagementController', 'getSessionConfig'),
  });

  fastify.route({
    ...END_SESSION_ROUTE,
    schema: END_SESSION_SCHEMA,
    preHandler: apiKeyAuthHook,
    handler: resolveHandler('sessionManagementController', 'endSession'),
  });

  fastify.route({
    ...GET_DEVICE_SESSIONS_ROUTE,
    schema: GET_DEVICE_SESSIONS_SCHEMA,
    preHandler: deviceCookieAuthHook,
    handler: resolveHandler(
      'sessionManagementController',
      'getDeviceSessions',
    ),
  });
}
