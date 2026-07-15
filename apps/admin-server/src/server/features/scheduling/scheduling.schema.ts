import {
  CREATE_AUTO_SESSION_WINDOW_SCHEMA,
  CREATE_ON_DEMAND_SESSION_SCHEMA,
  CREATE_SCHEDULE_SCHEMA,
  DELETE_AUTO_SESSION_WINDOW_SCHEMA,
  DELETE_SCHEDULE_SCHEMA,
  END_SESSION_EARLY_SCHEMA,
  GET_AUTO_SESSION_WINDOW_SCHEMA,
  GET_SCHEDULE_SCHEMA,
  GET_SESSION_SCHEMA,
  LIST_AUTO_SESSION_WINDOWS_SCHEMA,
  LIST_SCHEDULES_SCHEMA,
  START_SESSION_EARLY_SCHEMA,
  UPDATE_AUTO_SESSION_WINDOW_SCHEMA,
  UPDATE_ROOM_SCHEDULE_CONFIG_SCHEMA,
  UPDATE_SCHEDULE_SCHEMA,
} from '@scribear/session-manager-schema';

import { ADMIN_BASE_PATH } from '#src/server/base-path.js';

const P_SCHEDULES = `${ADMIN_BASE_PATH}/schedules`;
const P_AUTO_WINDOWS = `${ADMIN_BASE_PATH}/auto-windows`;
const P_SESSIONS = `${ADMIN_BASE_PATH}/sessions`;

// Input validation reuses the exact Session Manager request shapes (body /
// querystring / params) — NEVER the `authorization` header, which the BFF
// injects server-side.

export const LIST_SCHEDULES_INPUT = {
  querystring: LIST_SCHEDULES_SCHEMA.querystring,
};
export const LIST_SCHEDULES_ROUTE = {
  method: 'GET' as const,
  url: `${P_SCHEDULES}/list`,
};

export const GET_SCHEDULE_INPUT = { params: GET_SCHEDULE_SCHEMA.params };
export const GET_SCHEDULE_ROUTE = {
  method: 'GET' as const,
  url: `${P_SCHEDULES}/get/:scheduleUid`,
};

export const CREATE_SCHEDULE_INPUT = { body: CREATE_SCHEDULE_SCHEMA.body };
export const CREATE_SCHEDULE_ROUTE = {
  method: 'POST' as const,
  url: `${P_SCHEDULES}/create`,
};

export const UPDATE_SCHEDULE_INPUT = { body: UPDATE_SCHEDULE_SCHEMA.body };
export const UPDATE_SCHEDULE_ROUTE = {
  method: 'POST' as const,
  url: `${P_SCHEDULES}/update`,
};

export const DELETE_SCHEDULE_INPUT = { body: DELETE_SCHEDULE_SCHEMA.body };
export const DELETE_SCHEDULE_ROUTE = {
  method: 'POST' as const,
  url: `${P_SCHEDULES}/delete`,
};

export const LIST_AUTO_SESSION_WINDOWS_INPUT = {
  querystring: LIST_AUTO_SESSION_WINDOWS_SCHEMA.querystring,
};
export const LIST_AUTO_SESSION_WINDOWS_ROUTE = {
  method: 'GET' as const,
  url: `${P_AUTO_WINDOWS}/list`,
};

export const GET_AUTO_SESSION_WINDOW_INPUT = {
  params: GET_AUTO_SESSION_WINDOW_SCHEMA.params,
};
export const GET_AUTO_SESSION_WINDOW_ROUTE = {
  method: 'GET' as const,
  url: `${P_AUTO_WINDOWS}/get/:windowUid`,
};

export const CREATE_AUTO_SESSION_WINDOW_INPUT = {
  body: CREATE_AUTO_SESSION_WINDOW_SCHEMA.body,
};
export const CREATE_AUTO_SESSION_WINDOW_ROUTE = {
  method: 'POST' as const,
  url: `${P_AUTO_WINDOWS}/create`,
};

export const UPDATE_AUTO_SESSION_WINDOW_INPUT = {
  body: UPDATE_AUTO_SESSION_WINDOW_SCHEMA.body,
};
export const UPDATE_AUTO_SESSION_WINDOW_ROUTE = {
  method: 'POST' as const,
  url: `${P_AUTO_WINDOWS}/update`,
};

export const DELETE_AUTO_SESSION_WINDOW_INPUT = {
  body: DELETE_AUTO_SESSION_WINDOW_SCHEMA.body,
};
export const DELETE_AUTO_SESSION_WINDOW_ROUTE = {
  method: 'POST' as const,
  url: `${P_AUTO_WINDOWS}/delete`,
};

export const UPDATE_ROOM_SCHEDULE_CONFIG_INPUT = {
  body: UPDATE_ROOM_SCHEDULE_CONFIG_SCHEMA.body,
};
export const UPDATE_ROOM_SCHEDULE_CONFIG_ROUTE = {
  method: 'POST' as const,
  url: `${P_SCHEDULES}/room-config`,
};

export const GET_SESSION_INPUT = { params: GET_SESSION_SCHEMA.params };
export const GET_SESSION_ROUTE = {
  method: 'GET' as const,
  url: `${P_SESSIONS}/get/:sessionUid`,
};

export const CREATE_ON_DEMAND_SESSION_INPUT = {
  body: CREATE_ON_DEMAND_SESSION_SCHEMA.body,
};
export const CREATE_ON_DEMAND_SESSION_ROUTE = {
  method: 'POST' as const,
  url: `${P_SESSIONS}/create-on-demand`,
};

export const START_SESSION_EARLY_INPUT = {
  body: START_SESSION_EARLY_SCHEMA.body,
};
export const START_SESSION_EARLY_ROUTE = {
  method: 'POST' as const,
  url: `${P_SESSIONS}/start-early`,
};

export const END_SESSION_EARLY_INPUT = { body: END_SESSION_EARLY_SCHEMA.body };
export const END_SESSION_EARLY_ROUTE = {
  method: 'POST' as const,
  url: `${P_SESSIONS}/end-early`,
};
