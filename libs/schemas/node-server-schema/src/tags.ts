import type { BaseTagsDefinition } from '@scribear/base-schema';

export const PROBES_TAG = 'Probes';
export const STATUS_TAG = 'Status';
export const TRANSCRIPTION_STREAM_TAG = 'Transcription Stream';

export const OPENAPI_TAGS: BaseTagsDefinition = [
  { name: PROBES_TAG, description: 'Liveness and readiness probe endpoints.' },
  {
    name: STATUS_TAG,
    description:
      'Internal telemetry endpoint for observability consumers. Requires the service API key and is not exposed publicly.',
  },
  {
    name: TRANSCRIPTION_STREAM_TAG,
    description:
      'Bidirectional WebSocket endpoint for source devices to push audio and for any session participant to receive transcripts.',
  },
];
