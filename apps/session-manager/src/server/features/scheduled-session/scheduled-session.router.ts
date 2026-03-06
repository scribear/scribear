import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  CREATE_SCHEDULED_SESSION_ROUTE,
  CREATE_SCHEDULED_SESSION_SCHEMA,
  DELETE_SCHEDULED_SESSION_ROUTE,
  DELETE_SCHEDULED_SESSION_SCHEMA,
  GET_SCHEDULED_SESSION_ROUTE,
  GET_SCHEDULED_SESSION_SCHEMA,
  LIST_SCHEDULED_SESSIONS_ROUTE,
  LIST_SCHEDULED_SESSIONS_SCHEMA,
  UPDATE_SCHEDULED_SESSION_ROUTE,
  UPDATE_SCHEDULED_SESSION_SCHEMA,
} from '@scribear/session-manager-schema';

import resolveHandler from '../../dependency-injection/resolve-handler.js';

/**
 * Registers scheduled session CRUD routes
 * @param fastify Fastify app instance
 */
function scheduledSessionRouter(fastify: BaseFastifyInstance) {
  fastify.route({
    ...CREATE_SCHEDULED_SESSION_ROUTE,
    schema: CREATE_SCHEDULED_SESSION_SCHEMA,
    handler: resolveHandler('scheduledSessionController', 'create'),
  });

  fastify.route({
    ...GET_SCHEDULED_SESSION_ROUTE,
    schema: GET_SCHEDULED_SESSION_SCHEMA,
    handler: resolveHandler('scheduledSessionController', 'getById'),
  });

  fastify.route({
    ...LIST_SCHEDULED_SESSIONS_ROUTE,
    schema: LIST_SCHEDULED_SESSIONS_SCHEMA,
    handler: resolveHandler('scheduledSessionController', 'list'),
  });

  fastify.route({
    ...UPDATE_SCHEDULED_SESSION_ROUTE,
    schema: UPDATE_SCHEDULED_SESSION_SCHEMA,
    handler: resolveHandler('scheduledSessionController', 'update'),
  });

  fastify.route({
    ...DELETE_SCHEDULED_SESSION_ROUTE,
    schema: DELETE_SCHEDULED_SESSION_SCHEMA,
    handler: resolveHandler('scheduledSessionController', 'delete'),
  });
}

export default scheduledSessionRouter;