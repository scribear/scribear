import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { csrfHook } from '#src/server/shared/hooks/csrf.hook.js';
import { requireRole } from '#src/server/shared/hooks/require-role.hook.js';
import { requireSessionHook } from '#src/server/shared/hooks/require-session.hook.js';
import { ROLE_READ_WRITE } from '#src/server/shared/types/identity.js';

import {
  ADD_DEVICE_INPUT,
  ADD_DEVICE_ROUTE,
  CREATE_ROOM_INPUT,
  CREATE_ROOM_ROUTE,
  DELETE_ROOM_INPUT,
  DELETE_ROOM_ROUTE,
  GET_ROOM_INPUT,
  GET_ROOM_ROUTE,
  LIST_ROOMS_INPUT,
  LIST_ROOMS_ROUTE,
  REMOVE_DEVICE_INPUT,
  REMOVE_DEVICE_ROUTE,
  ROOM_DETAIL_INPUT,
  ROOM_DETAIL_ROUTE,
  SET_SOURCE_INPUT,
  SET_SOURCE_ROUTE,
  UPDATE_ROOM_INPUT,
  UPDATE_ROOM_ROUTE,
} from './rooms.schema.js';

export function roomsRouter(fastify: BaseFastifyInstance) {
  // Reads: any authenticated session.
  const readGuards = [requireSessionHook];
  // Mutations: authenticated + CSRF + read-write role.
  const writeGuards = [
    requireSessionHook,
    csrfHook,
    requireRole(ROLE_READ_WRITE),
  ];

  fastify.route({
    ...LIST_ROOMS_ROUTE,
    schema: LIST_ROOMS_INPUT,
    preHandler: readGuards,
    handler: resolveHandler('roomsController', 'list'),
  });

  fastify.route({
    ...GET_ROOM_ROUTE,
    schema: GET_ROOM_INPUT,
    preHandler: readGuards,
    handler: resolveHandler('roomsController', 'get'),
  });

  fastify.route({
    ...ROOM_DETAIL_ROUTE,
    schema: ROOM_DETAIL_INPUT,
    preHandler: readGuards,
    handler: resolveHandler('roomsController', 'detail'),
  });

  fastify.route({
    ...CREATE_ROOM_ROUTE,
    schema: CREATE_ROOM_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('roomsController', 'create'),
  });

  fastify.route({
    ...UPDATE_ROOM_ROUTE,
    schema: UPDATE_ROOM_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('roomsController', 'update'),
  });

  fastify.route({
    ...DELETE_ROOM_ROUTE,
    schema: DELETE_ROOM_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('roomsController', 'delete'),
  });

  fastify.route({
    ...ADD_DEVICE_ROUTE,
    schema: ADD_DEVICE_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('roomsController', 'addDevice'),
  });

  fastify.route({
    ...REMOVE_DEVICE_ROUTE,
    schema: REMOVE_DEVICE_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('roomsController', 'removeDevice'),
  });

  fastify.route({
    ...SET_SOURCE_ROUTE,
    schema: SET_SOURCE_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('roomsController', 'setSource'),
  });
}
