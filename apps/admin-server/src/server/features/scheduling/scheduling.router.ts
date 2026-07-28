import type { BaseFastifyInstance } from '@scribear/base-fastify-server';

import resolveHandler from '#src/server/dependency-injection/resolve-handler.js';
import { csrfHook } from '#src/server/shared/hooks/csrf.hook.js';
import { requireRole } from '#src/server/shared/hooks/require-role.hook.js';
import { requireSessionHook } from '#src/server/shared/hooks/require-session.hook.js';
import { ROLE_READ_WRITE } from '#src/server/shared/types/identity.js';

import {
  CREATE_AUTO_SESSION_WINDOW_INPUT,
  CREATE_AUTO_SESSION_WINDOW_ROUTE,
  CREATE_ON_DEMAND_SESSION_INPUT,
  CREATE_ON_DEMAND_SESSION_ROUTE,
  CREATE_SCHEDULE_INPUT,
  CREATE_SCHEDULE_ROUTE,
  DELETE_AUTO_SESSION_WINDOW_INPUT,
  DELETE_AUTO_SESSION_WINDOW_ROUTE,
  DELETE_SCHEDULE_INPUT,
  DELETE_SCHEDULE_ROUTE,
  END_SESSION_EARLY_INPUT,
  END_SESSION_EARLY_ROUTE,
  GET_ACTIVE_SESSION_INPUT,
  GET_ACTIVE_SESSION_ROUTE,
  GET_AUTO_SESSION_WINDOW_INPUT,
  GET_AUTO_SESSION_WINDOW_ROUTE,
  GET_SCHEDULE_INPUT,
  GET_SCHEDULE_ROUTE,
  GET_SESSION_INPUT,
  GET_SESSION_JOIN_CODE_INPUT,
  GET_SESSION_JOIN_CODE_ROUTE,
  GET_SESSION_ROUTE,
  LIST_AUTO_SESSION_WINDOWS_INPUT,
  LIST_AUTO_SESSION_WINDOWS_ROUTE,
  LIST_SCHEDULES_INPUT,
  LIST_SCHEDULES_ROUTE,
  LIST_SESSIONS_INPUT,
  LIST_SESSIONS_ROUTE,
  START_SESSION_EARLY_INPUT,
  START_SESSION_EARLY_ROUTE,
  UPDATE_AUTO_SESSION_WINDOW_INPUT,
  UPDATE_AUTO_SESSION_WINDOW_ROUTE,
  UPDATE_ROOM_SCHEDULE_CONFIG_INPUT,
  UPDATE_ROOM_SCHEDULE_CONFIG_ROUTE,
  UPDATE_SCHEDULE_INPUT,
  UPDATE_SCHEDULE_ROUTE,
} from './scheduling.schema.js';

export function schedulingRouter(fastify: BaseFastifyInstance) {
  // Reads: any authenticated session.
  const readGuards = [requireSessionHook];
  // Mutations: authenticated + CSRF + read-write role.
  const writeGuards = [
    requireSessionHook,
    csrfHook,
    requireRole(ROLE_READ_WRITE),
  ];

  fastify.route({
    ...LIST_SCHEDULES_ROUTE,
    schema: LIST_SCHEDULES_INPUT,
    preHandler: readGuards,
    handler: resolveHandler('schedulingController', 'listSchedules'),
  });

  fastify.route({
    ...GET_SCHEDULE_ROUTE,
    schema: GET_SCHEDULE_INPUT,
    preHandler: readGuards,
    handler: resolveHandler('schedulingController', 'getSchedule'),
  });

  fastify.route({
    ...LIST_AUTO_SESSION_WINDOWS_ROUTE,
    schema: LIST_AUTO_SESSION_WINDOWS_INPUT,
    preHandler: readGuards,
    handler: resolveHandler('schedulingController', 'listAutoWindows'),
  });

  fastify.route({
    ...GET_AUTO_SESSION_WINDOW_ROUTE,
    schema: GET_AUTO_SESSION_WINDOW_INPUT,
    preHandler: readGuards,
    handler: resolveHandler('schedulingController', 'getAutoWindow'),
  });

  fastify.route({
    ...GET_SESSION_ROUTE,
    schema: GET_SESSION_INPUT,
    preHandler: readGuards,
    handler: resolveHandler('schedulingController', 'getSession'),
  });

  fastify.route({
    ...LIST_SESSIONS_ROUTE,
    schema: LIST_SESSIONS_INPUT,
    preHandler: readGuards,
    handler: resolveHandler('schedulingController', 'listSessions'),
  });

  fastify.route({
    ...GET_ACTIVE_SESSION_ROUTE,
    schema: GET_ACTIVE_SESSION_INPUT,
    preHandler: readGuards,
    handler: resolveHandler('schedulingController', 'getActiveSession'),
  });

  fastify.route({
    ...GET_SESSION_JOIN_CODE_ROUTE,
    schema: GET_SESSION_JOIN_CODE_INPUT,
    preHandler: readGuards,
    handler: resolveHandler('schedulingController', 'getSessionJoinCode'),
  });

  fastify.route({
    ...CREATE_SCHEDULE_ROUTE,
    schema: CREATE_SCHEDULE_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('schedulingController', 'createSchedule'),
  });

  fastify.route({
    ...UPDATE_SCHEDULE_ROUTE,
    schema: UPDATE_SCHEDULE_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('schedulingController', 'updateSchedule'),
  });

  fastify.route({
    ...DELETE_SCHEDULE_ROUTE,
    schema: DELETE_SCHEDULE_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('schedulingController', 'deleteSchedule'),
  });

  fastify.route({
    ...CREATE_AUTO_SESSION_WINDOW_ROUTE,
    schema: CREATE_AUTO_SESSION_WINDOW_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('schedulingController', 'createAutoWindow'),
  });

  fastify.route({
    ...UPDATE_AUTO_SESSION_WINDOW_ROUTE,
    schema: UPDATE_AUTO_SESSION_WINDOW_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('schedulingController', 'updateAutoWindow'),
  });

  fastify.route({
    ...DELETE_AUTO_SESSION_WINDOW_ROUTE,
    schema: DELETE_AUTO_SESSION_WINDOW_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('schedulingController', 'deleteAutoWindow'),
  });

  fastify.route({
    ...UPDATE_ROOM_SCHEDULE_CONFIG_ROUTE,
    schema: UPDATE_ROOM_SCHEDULE_CONFIG_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('schedulingController', 'updateRoomScheduleConfig'),
  });

  fastify.route({
    ...CREATE_ON_DEMAND_SESSION_ROUTE,
    schema: CREATE_ON_DEMAND_SESSION_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('schedulingController', 'createOnDemandSession'),
  });

  fastify.route({
    ...START_SESSION_EARLY_ROUTE,
    schema: START_SESSION_EARLY_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('schedulingController', 'startSessionEarly'),
  });

  fastify.route({
    ...END_SESSION_EARLY_ROUTE,
    schema: END_SESSION_EARLY_INPUT,
    preHandler: writeGuards,
    handler: resolveHandler('schedulingController', 'endSessionEarly'),
  });
}
