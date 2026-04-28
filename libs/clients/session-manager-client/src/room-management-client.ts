import { createEndpointClient } from '@scribear/base-api-client';
import {
  ADD_DEVICE_TO_ROOM_ROUTE,
  ADD_DEVICE_TO_ROOM_SCHEMA,
  CREATE_ROOM_ROUTE,
  CREATE_ROOM_SCHEMA,
  DELETE_ROOM_ROUTE,
  DELETE_ROOM_SCHEMA,
  GET_MY_ROOM_ROUTE,
  GET_MY_ROOM_SCHEMA,
  GET_ROOM_ROUTE,
  GET_ROOM_SCHEMA,
  LIST_ROOMS_ROUTE,
  LIST_ROOMS_SCHEMA,
  REMOVE_DEVICE_FROM_ROOM_ROUTE,
  REMOVE_DEVICE_FROM_ROOM_SCHEMA,
  SET_SOURCE_DEVICE_ROUTE,
  SET_SOURCE_DEVICE_SCHEMA,
  UPDATE_ROOM_ROUTE,
  UPDATE_ROOM_SCHEMA,
} from '@scribear/session-manager-schema';

function createRoomManagementClient(baseUrl: string) {
  return {
    listRooms: createEndpointClient(
      LIST_ROOMS_SCHEMA,
      LIST_ROOMS_ROUTE,
      baseUrl,
    ),
    getRoom: createEndpointClient(GET_ROOM_SCHEMA, GET_ROOM_ROUTE, baseUrl),
    createRoom: createEndpointClient(
      CREATE_ROOM_SCHEMA,
      CREATE_ROOM_ROUTE,
      baseUrl,
    ),
    updateRoom: createEndpointClient(
      UPDATE_ROOM_SCHEMA,
      UPDATE_ROOM_ROUTE,
      baseUrl,
    ),
    deleteRoom: createEndpointClient(
      DELETE_ROOM_SCHEMA,
      DELETE_ROOM_ROUTE,
      baseUrl,
    ),
    addDeviceToRoom: createEndpointClient(
      ADD_DEVICE_TO_ROOM_SCHEMA,
      ADD_DEVICE_TO_ROOM_ROUTE,
      baseUrl,
    ),
    removeDeviceFromRoom: createEndpointClient(
      REMOVE_DEVICE_FROM_ROOM_SCHEMA,
      REMOVE_DEVICE_FROM_ROOM_ROUTE,
      baseUrl,
    ),
    setSourceDevice: createEndpointClient(
      SET_SOURCE_DEVICE_SCHEMA,
      SET_SOURCE_DEVICE_ROUTE,
      baseUrl,
    ),
    getMyRoom: createEndpointClient(
      GET_MY_ROOM_SCHEMA,
      GET_MY_ROOM_ROUTE,
      baseUrl,
    ),
  };
}

export { createRoomManagementClient };
