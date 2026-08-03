import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import { STATUS_ROUTE, STATUS_SCHEMA } from '@scribear/node-server-schema';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { serviceApiKeyHook } from '#src/server/hooks/service-api-key.hook.js';

export function statusRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...STATUS_ROUTE,
    schema: STATUS_SCHEMA,
    // Attached per route rather than plugin-scoped, so the probes and the
    // transcription WebSocket cannot accidentally inherit an API key
    // requirement.
    preHandler: serviceApiKeyHook,
    handler: resolveHandler('statusController', 'status'),
  });
}
