import type { BaseTagsDefinition } from '@scribear/base-schema';

export const HEALTHCHECK_TAG = 'Healthcheck';
export const SESSION_STREAMING_TAG = 'Session Streaming';

export const OPENAPI_TAGS: BaseTagsDefinition = [
  {
    name: HEALTHCHECK_TAG,
    description: 'Server health probe endpoint',
  },
  {
    name: SESSION_STREAMING_TAG,
    description:
      'Endpoints for streaming audio to the server and receiving live transcriptions',
  },
];
