import type { BaseTagsDefinition } from '@scribear/base-schema';

export const PROBES_TAG = 'Probes';
export const ROOM_MANAGEMENT_TAG = 'Room Management';
export const DEVICE_MANAGEMENT_TAG = 'Device Management';
export const SCHEDULE_MANAGEMENT_TAG = 'Schedule Management';
export const SESSION_MANAGEMENT_TAG = 'Session Management';
export const SESSION_AUTH_TAG = 'Session Auth';

export const OPENAPI_TAGS: BaseTagsDefinition = [
  { name: PROBES_TAG, description: 'Liveness and readiness probe endpoints.' },
  {
    name: ROOM_MANAGEMENT_TAG,
    description:
      'Rooms: CRUD, timezone configuration, device membership, and schedule-change streaming.',
  },
  {
    name: DEVICE_MANAGEMENT_TAG,
    description: 'Device registration, activation, and lifecycle.',
  },
  {
    name: SCHEDULE_MANAGEMENT_TAG,
    description: 'Recurring session schedules and their lifecycle.',
  },
  {
    name: SESSION_MANAGEMENT_TAG,
    description:
      'Materialized sessions: list, on-demand creation, start/end early, and status streams.',
  },
  {
    name: SESSION_AUTH_TAG,
    description:
      'Join code issuance, join code exchange, source-device session auth, and session token refresh.',
  },
];
