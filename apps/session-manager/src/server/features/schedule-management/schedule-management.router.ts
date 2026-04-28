import type { BaseFastifyInstance } from '@scribear/base-fastify-server';
import {
  CREATE_AUTO_SESSION_WINDOW_ROUTE,
  CREATE_AUTO_SESSION_WINDOW_SCHEMA,
  CREATE_ON_DEMAND_SESSION_ROUTE,
  CREATE_ON_DEMAND_SESSION_SCHEMA,
  CREATE_SCHEDULE_ROUTE,
  CREATE_SCHEDULE_SCHEMA,
  DELETE_AUTO_SESSION_WINDOW_ROUTE,
  DELETE_AUTO_SESSION_WINDOW_SCHEMA,
  DELETE_SCHEDULE_ROUTE,
  DELETE_SCHEDULE_SCHEMA,
  END_SESSION_EARLY_ROUTE,
  END_SESSION_EARLY_SCHEMA,
  GET_AUTO_SESSION_WINDOW_ROUTE,
  GET_AUTO_SESSION_WINDOW_SCHEMA,
  GET_SCHEDULE_ROUTE,
  GET_SCHEDULE_SCHEMA,
  GET_SESSION_ROUTE,
  GET_SESSION_SCHEMA,
  LIST_AUTO_SESSION_WINDOWS_ROUTE,
  LIST_AUTO_SESSION_WINDOWS_SCHEMA,
  LIST_SCHEDULES_ROUTE,
  LIST_SCHEDULES_SCHEMA,
  MY_SCHEDULE_ROUTE,
  MY_SCHEDULE_SCHEMA,
  SESSION_CONFIG_STREAM_ROUTE,
  SESSION_CONFIG_STREAM_SCHEMA,
  START_SESSION_EARLY_ROUTE,
  START_SESSION_EARLY_SCHEMA,
  UPDATE_AUTO_SESSION_WINDOW_ROUTE,
  UPDATE_AUTO_SESSION_WINDOW_SCHEMA,
  UPDATE_ROOM_SCHEDULE_CONFIG_ROUTE,
  UPDATE_ROOM_SCHEDULE_CONFIG_SCHEMA,
  UPDATE_SCHEDULE_ROUTE,
  UPDATE_SCHEDULE_SCHEMA,
} from '@scribear/session-manager-schema';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { adminApiKeyHook } from '#src/server/hooks/admin-api-key.hook.js';
import { deviceTokenHook } from '#src/server/hooks/device-token.hook.js';
import { serviceApiKeyHook } from '#src/server/hooks/service-api-key.hook.js';

export function scheduleManagementRouter(fastify: BaseFastifyInstance) {
  // Schedule CRUD
  fastify.route({
    ...LIST_SCHEDULES_ROUTE,
    schema: LIST_SCHEDULES_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('scheduleManagementController', 'listSchedules'),
  });

  fastify.route({
    ...CREATE_SCHEDULE_ROUTE,
    schema: CREATE_SCHEDULE_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('scheduleManagementController', 'createSchedule'),
  });

  fastify.route({
    ...GET_SCHEDULE_ROUTE,
    schema: GET_SCHEDULE_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('scheduleManagementController', 'getSchedule'),
  });

  fastify.route({
    ...UPDATE_SCHEDULE_ROUTE,
    schema: UPDATE_SCHEDULE_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('scheduleManagementController', 'updateSchedule'),
  });

  fastify.route({
    ...DELETE_SCHEDULE_ROUTE,
    schema: DELETE_SCHEDULE_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('scheduleManagementController', 'deleteSchedule'),
  });

  // Auto-session window CRUD
  fastify.route({
    ...LIST_AUTO_SESSION_WINDOWS_ROUTE,
    schema: LIST_AUTO_SESSION_WINDOWS_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler(
      'scheduleManagementController',
      'listAutoSessionWindows',
    ),
  });

  fastify.route({
    ...CREATE_AUTO_SESSION_WINDOW_ROUTE,
    schema: CREATE_AUTO_SESSION_WINDOW_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler(
      'scheduleManagementController',
      'createAutoSessionWindow',
    ),
  });

  fastify.route({
    ...GET_AUTO_SESSION_WINDOW_ROUTE,
    schema: GET_AUTO_SESSION_WINDOW_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler(
      'scheduleManagementController',
      'getAutoSessionWindow',
    ),
  });

  fastify.route({
    ...UPDATE_AUTO_SESSION_WINDOW_ROUTE,
    schema: UPDATE_AUTO_SESSION_WINDOW_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler(
      'scheduleManagementController',
      'updateAutoSessionWindow',
    ),
  });

  fastify.route({
    ...DELETE_AUTO_SESSION_WINDOW_ROUTE,
    schema: DELETE_AUTO_SESSION_WINDOW_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler(
      'scheduleManagementController',
      'deleteAutoSessionWindow',
    ),
  });

  // Room schedule config
  fastify.route({
    ...UPDATE_ROOM_SCHEDULE_CONFIG_ROUTE,
    schema: UPDATE_ROOM_SCHEDULE_CONFIG_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler(
      'scheduleManagementController',
      'updateRoomScheduleConfig',
    ),
  });

  // Session operations
  fastify.route({
    ...GET_SESSION_ROUTE,
    schema: GET_SESSION_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('scheduleManagementController', 'getSession'),
  });

  fastify.route({
    ...CREATE_ON_DEMAND_SESSION_ROUTE,
    schema: CREATE_ON_DEMAND_SESSION_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler(
      'scheduleManagementController',
      'createOnDemandSession',
    ),
  });

  fastify.route({
    ...START_SESSION_EARLY_ROUTE,
    schema: START_SESSION_EARLY_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler(
      'scheduleManagementController',
      'startSessionEarly',
    ),
  });

  fastify.route({
    ...END_SESSION_EARLY_ROUTE,
    schema: END_SESSION_EARLY_SCHEMA,
    preHandler: adminApiKeyHook,
    handler: resolveHandler('scheduleManagementController', 'endSessionEarly'),
  });

  // Long-poll endpoints
  fastify.route({
    ...MY_SCHEDULE_ROUTE,
    schema: MY_SCHEDULE_SCHEMA,
    preHandler: deviceTokenHook,
    handler: resolveHandler('scheduleManagementController', 'mySchedule'),
  });

  fastify.route({
    ...SESSION_CONFIG_STREAM_ROUTE,
    schema: SESSION_CONFIG_STREAM_SCHEMA,
    preHandler: serviceApiKeyHook,
    handler: resolveHandler(
      'scheduleManagementController',
      'sessionConfigStream',
    ),
  });
}
