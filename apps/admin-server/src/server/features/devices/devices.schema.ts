import {
  DELETE_DEVICE_SCHEMA,
  GET_DEVICE_SCHEMA,
  LIST_DEVICES_SCHEMA,
  REGISTER_DEVICE_SCHEMA,
  REREGISTER_DEVICE_SCHEMA,
  UPDATE_DEVICE_SCHEMA,
} from '@scribear/session-manager-schema';

import { ADMIN_BASE_PATH } from '#src/server/base-path.js';

const P = `${ADMIN_BASE_PATH}/devices`;

export const LIST_DEVICES_INPUT = {
  querystring: LIST_DEVICES_SCHEMA.querystring,
};
export const LIST_DEVICES_ROUTE = { method: 'GET' as const, url: `${P}/list` };

export const GET_DEVICE_INPUT = { params: GET_DEVICE_SCHEMA.params };
export const GET_DEVICE_ROUTE = {
  method: 'GET' as const,
  url: `${P}/get/:deviceUid`,
};

export const REGISTER_DEVICE_INPUT = { body: REGISTER_DEVICE_SCHEMA.body };
export const REGISTER_DEVICE_ROUTE = {
  method: 'POST' as const,
  url: `${P}/register`,
};

export const REREGISTER_DEVICE_INPUT = { body: REREGISTER_DEVICE_SCHEMA.body };
export const REREGISTER_DEVICE_ROUTE = {
  method: 'POST' as const,
  url: `${P}/reregister`,
};

export const UPDATE_DEVICE_INPUT = { body: UPDATE_DEVICE_SCHEMA.body };
export const UPDATE_DEVICE_ROUTE = {
  method: 'POST' as const,
  url: `${P}/update`,
};

export const DELETE_DEVICE_INPUT = { body: DELETE_DEVICE_SCHEMA.body };
export const DELETE_DEVICE_ROUTE = {
  method: 'POST' as const,
  url: `${P}/delete`,
};
