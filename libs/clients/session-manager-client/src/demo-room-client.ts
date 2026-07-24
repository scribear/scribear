import { createEndpointClient } from '@scribear/base-api-client';
import {
  DEMO_ROOM_STATUS_ROUTE,
  DEMO_ROOM_STATUS_SCHEMA,
} from '@scribear/session-manager-schema';

function createDemoRoomClient(baseUrl: string) {
  return {
    status: createEndpointClient(
      DEMO_ROOM_STATUS_SCHEMA,
      DEMO_ROOM_STATUS_ROUTE,
      baseUrl,
    ),
  };
}

export { createDemoRoomClient };
