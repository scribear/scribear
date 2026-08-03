import {
  ADD_DEVICE_TO_ROOM_SCHEMA,
  CREATE_ROOM_SCHEMA,
  DELETE_ROOM_SCHEMA,
  GET_ROOM_SCHEMA,
  LIST_ROOMS_SCHEMA,
  REMOVE_DEVICE_FROM_ROOM_SCHEMA,
  SET_SOURCE_DEVICE_SCHEMA,
  UPDATE_ROOM_SCHEMA,
} from '@scribear/session-manager-schema';

import { ADMIN_BASE_PATH } from '#src/server/base-path.js';

const P = `${ADMIN_BASE_PATH}/rooms`;

// Input validation reuses the exact Session Manager request shapes (body /
// querystring / params) — NEVER the `authorization` header, which the BFF
// injects server-side.

export const LIST_ROOMS_INPUT = { querystring: LIST_ROOMS_SCHEMA.querystring };
export const LIST_ROOMS_ROUTE = { method: 'GET' as const, url: `${P}/list` };

export const GET_ROOM_INPUT = { params: GET_ROOM_SCHEMA.params };
export const GET_ROOM_ROUTE = {
  method: 'GET' as const,
  url: `${P}/get/:roomUid`,
};

export const ROOM_DETAIL_INPUT = { params: GET_ROOM_SCHEMA.params };
export const ROOM_DETAIL_ROUTE = {
  method: 'GET' as const,
  url: `${P}/detail/:roomUid`,
};

export const CREATE_ROOM_INPUT = { body: CREATE_ROOM_SCHEMA.body };
export const CREATE_ROOM_ROUTE = {
  method: 'POST' as const,
  url: `${P}/create`,
};

export const UPDATE_ROOM_INPUT = { body: UPDATE_ROOM_SCHEMA.body };
export const UPDATE_ROOM_ROUTE = {
  method: 'POST' as const,
  url: `${P}/update`,
};

export const DELETE_ROOM_INPUT = { body: DELETE_ROOM_SCHEMA.body };
export const DELETE_ROOM_ROUTE = {
  method: 'POST' as const,
  url: `${P}/delete`,
};

export const ADD_DEVICE_INPUT = { body: ADD_DEVICE_TO_ROOM_SCHEMA.body };
export const ADD_DEVICE_ROUTE = {
  method: 'POST' as const,
  url: `${P}/add-device`,
};

export const REMOVE_DEVICE_INPUT = {
  body: REMOVE_DEVICE_FROM_ROOM_SCHEMA.body,
};
export const REMOVE_DEVICE_ROUTE = {
  method: 'POST' as const,
  url: `${P}/remove-device`,
};

export const SET_SOURCE_INPUT = { body: SET_SOURCE_DEVICE_SCHEMA.body };
export const SET_SOURCE_ROUTE = {
  method: 'POST' as const,
  url: `${P}/set-source`,
};
