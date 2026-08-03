import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { csrfHook } from '#src/server/shared/hooks/csrf.hook.js';
import { requireRole } from '#src/server/shared/hooks/require-role.hook.js';
import { requireSessionHook } from '#src/server/shared/hooks/require-session.hook.js';
import { ROLE_READ_WRITE } from '#src/server/shared/types/identity.js';

import {
  DELETE_DEVICE_INPUT,
  DELETE_DEVICE_ROUTE,
  GET_DEVICE_INPUT,
  GET_DEVICE_ROUTE,
  LIST_DEVICES_INPUT,
  LIST_DEVICES_ROUTE,
  REGISTER_DEVICE_INPUT,
  REGISTER_DEVICE_ROUTE,
  REREGISTER_DEVICE_INPUT,
  REREGISTER_DEVICE_ROUTE,
  UPDATE_DEVICE_INPUT,
  UPDATE_DEVICE_ROUTE,
} from './devices.schema.js';

export function devicesRouter(fastify: BaseFastifyInstance) {
  const readGuards = [requireSessionHook];
  const writeGuards = [
    requireSessionHook,
    csrfHook,
    requireRole(ROLE_READ_WRITE),
  ];

  fastify.route({
    ...LIST_DEVICES_ROUTE,
    schema: LIST_DEVICES_INPUT,
    preHandler: readGuards,
    handler: resolveHandler('devicesController', 'list'),
  });

  fastify.route({
    ...GET_DEVICE_ROUTE,
    schema: GET_DEVICE_INPUT,
    preHandler: readGuards,
    handler: resolveHandler('devicesController', 'get'),
  });

  fastify.route({
    ...REGISTER_DEVICE_ROUTE,
    schema: REGISTER_DEVICE_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('devicesController', 'register'),
  });

  fastify.route({
    ...REREGISTER_DEVICE_ROUTE,
    schema: REREGISTER_DEVICE_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('devicesController', 'reregister'),
  });

  fastify.route({
    ...UPDATE_DEVICE_ROUTE,
    schema: UPDATE_DEVICE_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('devicesController', 'update'),
  });

  fastify.route({
    ...DELETE_DEVICE_ROUTE,
    schema: DELETE_DEVICE_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('devicesController', 'delete'),
  });
}
