import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { serviceKeyHook } from '#src/server/hooks/service-key.hook.js';

import {
  LIST_DEVICES_ROUTE,
  START_DEVICE_INPUT,
  START_DEVICE_ROUTE,
  STOP_DEVICE_INPUT,
  STOP_DEVICE_ROUTE,
  UPDATE_PARAMS_INPUT,
  UPDATE_PARAMS_ROUTE,
} from './devices.schema.js';

/**
 * Every route here takes the service key, including the read.
 *
 * The read is not harmless: it reports which rooms the two devices reach and
 * what the last captions were, which is a window into a live session. And a
 * caller who can read the device list is one request away from starting one.
 *
 * No `response` schema is declared on any of them, unlike the probes. The BFF
 * passes our body through to the operator's page untouched, on the stated
 * principle that a generator that adds a field should surface it without an
 * admin-server release; a serializer that strips unknown properties would make
 * that principle false one release later, from this side. The bodies are built
 * from `DeviceState`, which is typed.
 */
export function devicesRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...LIST_DEVICES_ROUTE,
    onRequest: serviceKeyHook,
    handler: resolveHandler('devicesController', 'list'),
  });

  fastify.route({
    ...START_DEVICE_ROUTE,
    schema: START_DEVICE_INPUT,
    onRequest: serviceKeyHook,
    handler: resolveHandler('devicesController', 'start'),
  });

  fastify.route({
    ...STOP_DEVICE_ROUTE,
    schema: STOP_DEVICE_INPUT,
    onRequest: serviceKeyHook,
    handler: resolveHandler('devicesController', 'stop'),
  });

  fastify.route({
    ...UPDATE_PARAMS_ROUTE,
    schema: UPDATE_PARAMS_INPUT,
    onRequest: serviceKeyHook,
    handler: resolveHandler('devicesController', 'updateParams'),
  });
}
