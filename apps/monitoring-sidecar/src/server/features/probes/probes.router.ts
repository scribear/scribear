import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';

import {
  LIVENESS_ROUTE,
  LIVENESS_SCHEMA,
  READINESS_ROUTE,
  READINESS_SCHEMA,
} from './probes.schema.js';

export function probesRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...LIVENESS_ROUTE,
    schema: LIVENESS_SCHEMA,
    handler: resolveHandler('livenessController', 'liveness'),
  });

  fastify.route({
    ...READINESS_ROUTE,
    schema: READINESS_SCHEMA,
    handler: resolveHandler('readinessController', 'readiness'),
  });
}
