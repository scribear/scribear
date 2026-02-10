import type { BaseTagsDefinition } from '@scribear/base-schema';

export const HEALTHCHECK_TAG = 'Healthcheck';
export const KIOSK_MANAGEMENT_TAG = 'Kiosk Management';
export const SESSION_MANAGEMENT_TAG = 'Session Management';

export const OPENAPI_TAGS: BaseTagsDefinition = [
  {
    name: HEALTHCHECK_TAG,
    description: 'Server health probe endpoint',
  },
  {
    name: KIOSK_MANAGEMENT_TAG,
    description:
      'Endpoints for registering, modifying, and deregistering kiosks',
  },
  {
    name: SESSION_MANAGEMENT_TAG,
    description:
      'Endpoints for creating, scheduling, modifying, and deleting sessions.',
  },
];
