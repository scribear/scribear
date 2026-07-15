import { createDeviceManagementClient } from './device-management-client.js';
import { createProbesClient } from './probes-client.js';
import { createRoomManagementClient } from './room-management-client.js';
import { createScheduleManagementClient } from './schedule-management-client.js';
import { createSessionAuthClient } from './session-auth-client.js';

/**
 * Builds typed clients for every Session Manager HTTP route, grouped by
 * domain. Regular endpoints are exposed as fetch functions from
 * `createEndpointClient`; the schedule `sessionConfigStream` is a
 * `LongPollClientFactory` that constructs an independent poll client per call.
 *
 * @param baseUrl Base URL of the Session Manager service (no trailing slash).
 */
function createSessionManagerClient(baseUrl: string) {
  return {
    probes: createProbesClient(baseUrl),
    roomManagement: createRoomManagementClient(baseUrl),
    deviceManagement: createDeviceManagementClient(baseUrl),
    scheduleManagement: createScheduleManagementClient(baseUrl),
    sessionAuth: createSessionAuthClient(baseUrl),
  };
}

type SessionManagerClient = ReturnType<typeof createSessionManagerClient>;

export { createSessionManagerClient };
export type { SessionManagerClient };
