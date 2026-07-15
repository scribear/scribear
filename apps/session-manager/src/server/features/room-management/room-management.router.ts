import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  ADD_DEVICE_TO_ROOM_ROUTE,
  ADD_DEVICE_TO_ROOM_SCHEMA,
  CREATE_ROOM_ROUTE,
  CREATE_ROOM_SCHEMA,
  DELETE_ROOM_ROUTE,
  DELETE_ROOM_SCHEMA,
  GET_MY_ROOM_ROUTE,
  GET_MY_ROOM_SCHEMA,
  GET_ROOM_ROUTE,
  GET_ROOM_SCHEMA,
  LIST_ROOMS_ROUTE,
  LIST_ROOMS_SCHEMA,
  REMOVE_DEVICE_FROM_ROOM_ROUTE,
  REMOVE_DEVICE_FROM_ROOM_SCHEMA,
  SET_SOURCE_DEVICE_ROUTE,
  SET_SOURCE_DEVICE_SCHEMA,
  UPDATE_ROOM_ROUTE,
  UPDATE_ROOM_SCHEMA,
} from '@scribear/session-manager-schema';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { adminApiKeyHook } from '#src/server/hooks/admin-api-key.hook.js';
import { deviceTokenHook } from '#src/server/hooks/device-token.hook.js';

export function roomManagementRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...LIST_ROOMS_ROUTE,
    schema: LIST_ROOMS_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('roomManagementController', 'listRooms'),
  });

  fastify.route({
    ...GET_ROOM_ROUTE,
    schema: GET_ROOM_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('roomManagementController', 'getRoom'),
  });

  fastify.route({
    ...CREATE_ROOM_ROUTE,
    schema: CREATE_ROOM_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('roomManagementController', 'createRoom'),
  });

  fastify.route({
    ...UPDATE_ROOM_ROUTE,
    schema: UPDATE_ROOM_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('roomManagementController', 'updateRoom'),
  });

  fastify.route({
    ...DELETE_ROOM_ROUTE,
    schema: DELETE_ROOM_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('roomManagementController', 'deleteRoom'),
  });

  fastify.route({
    ...ADD_DEVICE_TO_ROOM_ROUTE,
    schema: ADD_DEVICE_TO_ROOM_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('roomManagementController', 'addDeviceToRoom'),
  });

  fastify.route({
    ...REMOVE_DEVICE_FROM_ROOM_ROUTE,
    schema: REMOVE_DEVICE_FROM_ROOM_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('roomManagementController', 'removeDeviceFromRoom'),
  });

  fastify.route({
    ...SET_SOURCE_DEVICE_ROUTE,
    schema: SET_SOURCE_DEVICE_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('roomManagementController', 'setSourceDevice'),
  });

  fastify.route({
    ...GET_MY_ROOM_ROUTE,
    schema: GET_MY_ROOM_SCHEMA,
    preHandler: deviceTokenHook,
    handler: resolveHandler('roomManagementController', 'getMyRoom'),
  });
}
