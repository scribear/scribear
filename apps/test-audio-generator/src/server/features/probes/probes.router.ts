import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';

import {
  LIVENESS_ROUTE,
  LIVENESS_SCHEMA,
  READINESS_ROUTE,
  READINESS_SCHEMA,
} from './probes.schema.js';

/**
 * The two probes, unauthenticated — the only routes here that are.
 *
 * The container's own `HEALTHCHECK` calls liveness and has no key to present,
 * and every other Node service in the stack leaves its probes open for the same
 * reason. They report nothing an unauthenticated caller on the backend network
 * could act on: whether the process is up, and whether a token is configured —
 * never which room, which session or what was said.
 */
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
