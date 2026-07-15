import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  ACTIVATE_DEVICE_ROUTE,
  ACTIVATE_DEVICE_SCHEMA,
  DELETE_DEVICE_ROUTE,
  DELETE_DEVICE_SCHEMA,
  GET_DEVICE_ROUTE,
  GET_DEVICE_SCHEMA,
  GET_MY_DEVICE_ROUTE,
  GET_MY_DEVICE_SCHEMA,
  LIST_DEVICES_ROUTE,
  LIST_DEVICES_SCHEMA,
  REGISTER_DEVICE_ROUTE,
  REGISTER_DEVICE_SCHEMA,
  REREGISTER_DEVICE_ROUTE,
  REREGISTER_DEVICE_SCHEMA,
  UPDATE_DEVICE_ROUTE,
  UPDATE_DEVICE_SCHEMA,
} from '@scribear/session-manager-schema';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { adminApiKeyHook } from '#src/server/hooks/admin-api-key.hook.js';
import { deviceTokenHook } from '#src/server/hooks/device-token.hook.js';

export function deviceManagementRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...LIST_DEVICES_ROUTE,
    schema: LIST_DEVICES_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('deviceManagementController', 'listDevices'),
  });

  fastify.route({
    ...GET_DEVICE_ROUTE,
    schema: GET_DEVICE_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('deviceManagementController', 'getDevice'),
  });

  fastify.route({
    ...REGISTER_DEVICE_ROUTE,
    schema: REGISTER_DEVICE_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('deviceManagementController', 'registerDevice'),
  });

  fastify.route({
    ...REREGISTER_DEVICE_ROUTE,
    schema: REREGISTER_DEVICE_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('deviceManagementController', 'reregisterDevice'),
  });

  fastify.route({
    ...ACTIVATE_DEVICE_ROUTE,
    schema: ACTIVATE_DEVICE_SCHEMA,
    handler: resolveHandler('deviceManagementController', 'activateDevice'),
  });

  fastify.route({
    ...UPDATE_DEVICE_ROUTE,
    schema: UPDATE_DEVICE_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('deviceManagementController', 'updateDevice'),
  });

  fastify.route({
    ...DELETE_DEVICE_ROUTE,
    schema: DELETE_DEVICE_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('deviceManagementController', 'deleteDevice'),
  });

  fastify.route({
    ...GET_MY_DEVICE_ROUTE,
    schema: GET_MY_DEVICE_SCHEMA,
    preHandler: deviceTokenHook,
    handler: resolveHandler('deviceManagementController', 'getMyDevice'),
  });
}
