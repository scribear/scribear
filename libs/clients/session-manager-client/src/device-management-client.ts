import { createEndpointClient } from '@scribear/base-api-client';
import {
  ACTIVATE_DEVICE_ROUTE,
  ACTIVATE_DEVICE_SCHEMA,
  DELETE_DEVICE_ROUTE,
  DELETE_DEVICE_SCHEMA,
  GET_DEVICE_ROUTE,
  GET_DEVICE_SCHEMA,
  GET_MY_DEVICE_ROUTE,
  GET_MY_DEVICE_SCHEMA,
  LIST_DEVICES_ROUTE,
  LIST_DEVICES_SCHEMA,
  REGISTER_DEVICE_ROUTE,
  REGISTER_DEVICE_SCHEMA,
  REREGISTER_DEVICE_ROUTE,
  REREGISTER_DEVICE_SCHEMA,
  UPDATE_DEVICE_ROUTE,
  UPDATE_DEVICE_SCHEMA,
} from '@scribear/session-manager-schema';

function createDeviceManagementClient(baseUrl: string) {
  return {
    listDevices: createEndpointClient(
      LIST_DEVICES_SCHEMA,
      LIST_DEVICES_ROUTE,
      baseUrl,
    ),
    getDevice: createEndpointClient(
      GET_DEVICE_SCHEMA,
      GET_DEVICE_ROUTE,
      baseUrl,
    ),
    registerDevice: createEndpointClient(
      REGISTER_DEVICE_SCHEMA,
      REGISTER_DEVICE_ROUTE,
      baseUrl,
    ),
    reregisterDevice: createEndpointClient(
      REREGISTER_DEVICE_SCHEMA,
      REREGISTER_DEVICE_ROUTE,
      baseUrl,
    ),
    activateDevice: createEndpointClient(
      ACTIVATE_DEVICE_SCHEMA,
      ACTIVATE_DEVICE_ROUTE,
      baseUrl,
    ),
    updateDevice: createEndpointClient(
      UPDATE_DEVICE_SCHEMA,
      UPDATE_DEVICE_ROUTE,
      baseUrl,
    ),
    deleteDevice: createEndpointClient(
      DELETE_DEVICE_SCHEMA,
      DELETE_DEVICE_ROUTE,
      baseUrl,
    ),
    getMyDevice: createEndpointClient(
      GET_MY_DEVICE_SCHEMA,
      GET_MY_DEVICE_ROUTE,
      baseUrl,
    ),
  };
}

export { createDeviceManagementClient };
