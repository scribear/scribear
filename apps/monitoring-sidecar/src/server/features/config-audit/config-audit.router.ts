import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';

import {
  CONFIG_AUDIT_ROUTE,
  CONFIG_AUDIT_SCHEMA,
} from './config-audit.schema.js';

export function configAuditRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...CONFIG_AUDIT_ROUTE,
    schema: CONFIG_AUDIT_SCHEMA,
    handler: resolveHandler('configAuditController', 'configAudit'),
  });
}
