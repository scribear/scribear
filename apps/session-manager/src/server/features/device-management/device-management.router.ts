import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  ACTIVATE_DEVICE_ROUTE,
  ACTIVATE_DEVICE_SCHEMA,
  REGISTER_DEVICE_ROUTE,
  REGISTER_DEVICE_SCHEMA,
} from '@scribear/session-manager-schema';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { apiKeyAuthHook } from '#src/server/hooks/api-key-auth.hook.js';

/**
 * Registers device management routes
 * @param fastify Fastify app instance
 */
export function deviceManagementRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...ACTIVATE_DEVICE_ROUTE,
    schema: ACTIVATE_DEVICE_SCHEMA,
    handler: resolveHandler('deviceManagementController', 'activateDevice'),
  });

  fastify.route({
    ...REGISTER_DEVICE_ROUTE,
    schema: REGISTER_DEVICE_SCHEMA,
    preHandler: apiKeyAuthHook,
    handler: resolveHandler('deviceManagementController', 'registerDevice'),
  });
}
