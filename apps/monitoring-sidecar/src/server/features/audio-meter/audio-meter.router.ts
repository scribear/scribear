import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';

import { AUDIO_METER_ROUTE, AUDIO_METER_SCHEMA } from './audio-meter.schema.js';

export function audioMeterRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...AUDIO_METER_ROUTE,
    schema: AUDIO_METER_SCHEMA,
    handler: resolveHandler('audioMeterController', 'page'),
  });
}
