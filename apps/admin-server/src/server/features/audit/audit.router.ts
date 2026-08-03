import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { requireSessionHook } from '#src/server/shared/hooks/require-session.hook.js';

import { LIST_AUDIT_ROUTE, LIST_AUDIT_SCHEMA } from './audit.schema.js';

export function auditRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...LIST_AUDIT_ROUTE,
    schema: LIST_AUDIT_SCHEMA,
    preHandler: [requireSessionHook],
    handler: resolveHandler('auditController', 'list'),
  });
}
