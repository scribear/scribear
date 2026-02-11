import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  REGISTER_KIOSK_ROUTE,
  REGISTER_KIOSK_SCHEMA,
} from '@scribear/session-manager-schema';

import resolveHandler from '../../dependency-injection/resolve-handler.js';
import { authenticateApiKey } from '../../hooks/authenticate-api-key.js';

/**
 * Registers kiosk management routes
 * @param fastify Fastify app instance
 */
export function kioskManagementRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...REGISTER_KIOSK_ROUTE,
    schema: REGISTER_KIOSK_SCHEMA,
    preHandler: authenticateApiKey,
    handler: resolveHandler('kioskManagementController', 'registerKiosk'),
  });
}
