import type { BaseTagsDefinition } from '@scribear/base-schema';

export const HEALTHCHECK_TAG = 'Healthcheck';
export const DEVICE_MANAGEMENT_TAG = 'Device Management';
export const SESSION_MANAGEMENT_TAG = 'Session Management';

export const OPENAPI_TAGS: BaseTagsDefinition = [
  {
    name: HEALTHCHECK_TAG,
    description: 'Server health probe endpoint',
  },
  {
    name: DEVICE_MANAGEMENT_TAG,
    description:
      'Endpoints for registering, modifying, and deregistering devices',
  },
  {
    name: SESSION_MANAGEMENT_TAG,
    description:
      'Endpoints for creating, scheduling, modifying, and deleting sessions.',
  },
];
