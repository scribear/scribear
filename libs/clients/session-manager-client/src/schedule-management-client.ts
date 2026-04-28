import { createEndpointClient } from '@scribear/base-api-client';
import { createLongPollClient } from '@scribear/base-long-poll-client';
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

function createScheduleManagementClient(baseUrl: string) {
  return {
    mySchedule: createLongPollClient(
      MY_SCHEDULE_SCHEMA,
      MY_SCHEDULE_ROUTE,
      baseUrl,
      'sinceVersion',
      'roomScheduleVersion',
    ),
    listSchedules: createEndpointClient(
      LIST_SCHEDULES_SCHEMA,
      LIST_SCHEDULES_ROUTE,
      baseUrl,
    ),
    createSchedule: createEndpointClient(
      CREATE_SCHEDULE_SCHEMA,
      CREATE_SCHEDULE_ROUTE,
      baseUrl,
    ),
    getSchedule: createEndpointClient(
      GET_SCHEDULE_SCHEMA,
      GET_SCHEDULE_ROUTE,
      baseUrl,
    ),
    updateSchedule: createEndpointClient(
      UPDATE_SCHEDULE_SCHEMA,
      UPDATE_SCHEDULE_ROUTE,
      baseUrl,
    ),
    deleteSchedule: createEndpointClient(
      DELETE_SCHEDULE_SCHEMA,
      DELETE_SCHEDULE_ROUTE,
      baseUrl,
    ),
    updateRoomScheduleConfig: createEndpointClient(
      UPDATE_ROOM_SCHEDULE_CONFIG_SCHEMA,
      UPDATE_ROOM_SCHEDULE_CONFIG_ROUTE,
      baseUrl,
    ),
    listAutoSessionWindows: createEndpointClient(
      LIST_AUTO_SESSION_WINDOWS_SCHEMA,
      LIST_AUTO_SESSION_WINDOWS_ROUTE,
      baseUrl,
    ),
    createAutoSessionWindow: createEndpointClient(
      CREATE_AUTO_SESSION_WINDOW_SCHEMA,
      CREATE_AUTO_SESSION_WINDOW_ROUTE,
      baseUrl,
    ),
    getAutoSessionWindow: createEndpointClient(
      GET_AUTO_SESSION_WINDOW_SCHEMA,
      GET_AUTO_SESSION_WINDOW_ROUTE,
      baseUrl,
    ),
    updateAutoSessionWindow: createEndpointClient(
      UPDATE_AUTO_SESSION_WINDOW_SCHEMA,
      UPDATE_AUTO_SESSION_WINDOW_ROUTE,
      baseUrl,
    ),
    deleteAutoSessionWindow: createEndpointClient(
      DELETE_AUTO_SESSION_WINDOW_SCHEMA,
      DELETE_AUTO_SESSION_WINDOW_ROUTE,
      baseUrl,
    ),
    getSession: createEndpointClient(
      GET_SESSION_SCHEMA,
      GET_SESSION_ROUTE,
      baseUrl,
    ),
    createOnDemandSession: createEndpointClient(
      CREATE_ON_DEMAND_SESSION_SCHEMA,
      CREATE_ON_DEMAND_SESSION_ROUTE,
      baseUrl,
    ),
    startSessionEarly: createEndpointClient(
      START_SESSION_EARLY_SCHEMA,
      START_SESSION_EARLY_ROUTE,
      baseUrl,
    ),
    endSessionEarly: createEndpointClient(
      END_SESSION_EARLY_SCHEMA,
      END_SESSION_EARLY_ROUTE,
      baseUrl,
    ),
    sessionConfigStream: createLongPollClient(
      SESSION_CONFIG_STREAM_SCHEMA,
      SESSION_CONFIG_STREAM_ROUTE,
      baseUrl,
      'sinceVersion',
      'sessionConfigVersion',
    ),
  };
}

export { createScheduleManagementClient };
