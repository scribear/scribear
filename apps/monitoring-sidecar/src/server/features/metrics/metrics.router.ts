import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';

import {
  ALERTS_ROUTE,
  ALERTS_SCHEMA,
  PROMETHEUS_ROUTE,
  PROMETHEUS_SCHEMA,
  SNAPSHOT_ROUTE,
  SNAPSHOT_SCHEMA,
} from './metrics.schema.js';

export function metricsRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...SNAPSHOT_ROUTE,
    schema: SNAPSHOT_SCHEMA,
    handler: resolveHandler('metricsController', 'snapshot'),
  });

  fastify.route({
    ...ALERTS_ROUTE,
    schema: ALERTS_SCHEMA,
    handler: resolveHandler('metricsController', 'alerts'),
  });

  fastify.route({
    ...PROMETHEUS_ROUTE,
    schema: PROMETHEUS_SCHEMA,
    handler: resolveHandler('metricsController', 'prometheus'),
  });
}
